# CP Coach implementation readiness

**Status:** Readiness review only; no schema or data changes authorized
**Audit date:** 2026-11-03
**Target direction:** Supabase PostgreSQL + Supabase Auth; Node API and a separate notification worker on Railway; static frontend on Cloudflare Pages
**Important:** The SQL below is a design draft, not an applied migration. Remote Supabase and D1 data were not accessible, so this report does not certify their contents or readiness.

## 1. Readiness decision

The approved direction is viable, but the project is **not ready to migrate production data**. The principal blockers are:

1. The two current SQLite profiles have no authenticated owner; their Codeforces handles do not establish ownership.
2. The existing public-mode owner identifier is an unauthenticated browser identifier, not a Supabase identity.
3. There is no verified browser export or live browser inspection for localStorage-only journal/virtual-contest data.
4. No live Supabase project or D1 contents were inspected. The Supabase social migration currently present in the worktree is uncommitted and has unverified RLS assumptions.
5. The existing training APIs do not enforce user-level ownership. They cannot be exposed as multi-user APIs until authentication, RLS, and authorization tests are implemented.
6. Notification state in D1, SQLite, or an active worker must be inventoried and reconciled before changing senders.
7. An older SQLite backup has neither the active `profiles.owner_id` column nor the three active SQLite notification tables.

No product feature, authentication configuration, database, migration, cloud project, or deployment was changed. A new local-only backup utility was added and tested only with a disposable SQLite WAL fixture; it does not migrate or overwrite the project's database files.

## 2. Evidence and limits

| Source | Inspection result |
|---|---|
| `backend/data/cp_coach.db` | Opened read-only with `PRAGMA query_only=ON`; actual schema has 23 application tables. Counts below are a point-in-time local inventory. |
| `data/cp_coach.db` | Opened read-only; zero application tables. |
| `backups/cp_coach_backup_20261029_192648.db` | Opened read-only; 20 application tables. Schema differs as described below. It is not a tested recovery copy. |
| Supabase | Checked-in `supabase/migrations/202611020001_phase1_social.sql` inspected. No live project connection, migration history, or remote rows were available. |
| Cloudflare D1 | Checked-in worker schema and application code inspected. `database_id` is a placeholder in configuration; remote D1 existence, schema version, and row counts are unknown. |
| Browser | Source code inspected, but the user's browser storage was not available. The source scan found localStorage use and no IndexedDB/sessionStorage references in the scanned frontend/backend paths. Do not treat browser-only notes, virtual contests, or snapshots as empty. |
| Hosting | No Railway service, production filesystem, or deployed configuration was inspected. Existing SQLite file presence in the repository does not establish the production source of truth. |

SQLite read-only WAL access may create/update the transient `-shm` lock/coordination sidecar. No SQLite data statements, schema changes, checkpoints, or application-data writes were run as part of this audit. For a real extraction, take a separately approved online backup and record its hash before relying on any source file.

## 3. Exact current SQLite schema and records

### 3.1 Active schema

Types, declared nullability, defaults, and primary keys below reflect `PRAGMA table_info` for the active database. `PK` denotes the declared primary key; SQLite may report a text primary-key column as nullable in `table_info`, so preserve the actual DDL semantics and validate nulls rather than assuming PostgreSQL behavior. Unique auto-indexes correspond to the unique constraints shown. Explicit indexes and foreign keys are listed per table.

| Table | Columns (type; `!` = NOT NULL; `PK` = primary key; `DEFAULT` shown literally) | Indexes / unique constraints | Foreign keys |
|---|---|---|---|
| `codeforces_contests` | `contest_id INTEGER PK`; `name TEXT!`; `start_time_seconds INTEGER!`; `duration_seconds INTEGER`; `phase TEXT`; `updated_at TEXT! DEFAULT datetime('now')` | PK | — |
| `contest_problem_reviews` | `id TEXT PK`; `profile_id TEXT!`; `contest_id INTEGER!`; `problem_index TEXT!`; `self_review_tag TEXT`; `self_review_notes TEXT`; `upsolve_status TEXT! DEFAULT 'UNSOLVED'`; `upsolved_submission_id INTEGER`; `updated_at TEXT! DEFAULT datetime('now')` | `idx_contest_problem_reviews_profile(profile_id,contest_id)`; UNIQUE `(profile_id,contest_id,problem_index)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `contest_problems_meta` | `id TEXT PK`; `contest_id INTEGER!`; `problem_index TEXT!`; `name TEXT!`; `rating INTEGER`; `tags TEXT! DEFAULT '[]'`; `cf_url TEXT` | UNIQUE `(contest_id,problem_index)`; PK | — |
| `curriculum_problems` | `id TEXT PK`; `problem_id TEXT!`; `source TEXT!`; `source_url TEXT!`; `name TEXT!`; `curriculum_stage TEXT!`; `topic TEXT!`; `target_rating INTEGER!`; `learning_objective TEXT!`; `prerequisites TEXT! DEFAULT '[]'`; `cf_contest_id INTEGER`; `cf_index TEXT`; `created_at TEXT! DEFAULT datetime('now')` | `idx_curriculum_problems_rating(target_rating)`; `idx_curriculum_problems_topic(topic)`; PK | — |
| `daily_problems` | `id TEXT PK`; `daily_set_id TEXT!`; `profile_id TEXT!`; `daily_set_date TEXT!`; `problem_id TEXT!`; `category TEXT!`; `reason TEXT!`; `target_rating INTEGER!`; `completed INTEGER! DEFAULT 0`; `solved_status TEXT`; `perceived_difficulty TEXT`; `time_spent_minutes INTEGER`; `notes TEXT`; `updated_at TEXT! DEFAULT datetime('now')`; `verified_cf_ac INTEGER DEFAULT 0`; `educational_source TEXT`; `educational_source_url TEXT`; `curriculum_stage TEXT`; `learning_objective TEXT`; `prerequisites TEXT DEFAULT '[]'`; `struggle_reason TEXT`; `is_opened INTEGER! DEFAULT 0`; `opened_at TEXT`; `attempted INTEGER! DEFAULT 0`; `self_reported_solved INTEGER! DEFAULT 0`; `difficulty_experience TEXT`; `solution_method TEXT`; `problem_opinion TEXT` | `idx_daily_problems_date(daily_set_date)`; `idx_daily_problems_set(daily_set_id)`; `idx_daily_problems_profile(profile_id)`; UNIQUE `(daily_set_id,problem_id)`; PK | `problem_id → problems.id`; `profile_id → profiles.id ON DELETE CASCADE`; `daily_set_id → daily_sets.id ON DELETE CASCADE` |
| `daily_sets` | `id TEXT PK`; `profile_id TEXT!`; `date TEXT!`; `generated_at TEXT! DEFAULT datetime('now')` | `idx_daily_sets_profile_date(profile_id,date)`; UNIQUE `(profile_id,date)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `learner_profile_state` | `profile_id TEXT PK`; `handle TEXT!`; `data_json TEXT!`; `updated_at TEXT! DEFAULT datetime('now')` | PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `notification_deliveries` | `id INTEGER PK AUTOINCREMENT`; `profile_id TEXT!`; `endpoint_hash TEXT!`; `notification_key TEXT!`; `status TEXT!`; `attempted_at TEXT! DEFAULT datetime('now')`; `sent_at TEXT`; `retry_after TEXT` | `idx_notification_deliveries_retry(status,retry_after)`; UNIQUE `(profile_id,endpoint_hash,notification_key)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `notification_settings` | `profile_id TEXT PK`; `contest_reminders INTEGER! DEFAULT 0`; `daily_reminders INTEGER! DEFAULT 0`; `reminder_time TEXT! DEFAULT '20:00'`; `updated_at TEXT! DEFAULT datetime('now')` | PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `problem_learning_events` | `id TEXT PK`; `profile_id TEXT!`; `problem_id TEXT!`; `source TEXT!`; `problem_name TEXT`; `contest_id INTEGER`; `problem_index TEXT`; `rating INTEGER`; `tags TEXT! DEFAULT '[]'`; `solved_status TEXT`; `perceived_difficulty TEXT`; `struggle_reason TEXT`; `notes TEXT`; `verified_ac INTEGER! DEFAULT 0`; `hints_revealed INTEGER`; `editorial_viewed INTEGER`; `source_key TEXT`; `occurred_at TEXT! DEFAULT datetime('now')`; `difficulty_experience TEXT`; `solution_method TEXT`; `problem_opinion TEXT` | `idx_problem_learning_events_problem(profile_id,problem_id,occurred_at)`; `idx_problem_learning_events_profile(profile_id,occurred_at)`; UNIQUE `source_key`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `problems` | `id TEXT PK`; `contest_id INTEGER!`; `problem_index TEXT!`; `name TEXT!`; `type TEXT`; `rating INTEGER`; `tags TEXT! DEFAULT '[]'`; `solved_count INTEGER DEFAULT 0`; `updated_at TEXT! DEFAULT datetime('now')` | `idx_problems_rating(rating)`; PK | — |
| `profile_cache` | `handle TEXT PK`; `rating INTEGER`; `max_rating INTEGER`; `rank TEXT`; `max_rank TEXT`; `avatar TEXT`; `title_photo TEXT`; `organization TEXT`; `city TEXT`; `country TEXT`; `raw_json TEXT`; `updated_at TEXT! DEFAULT datetime('now')` | PK | — |
| `profiles` | `id TEXT PK`; `handle TEXT!`; `owner_id TEXT`; `display_name TEXT`; `avatar TEXT`; `rating INTEGER`; `max_rating INTEGER`; `rank TEXT`; `max_rank TEXT`; `is_default INTEGER DEFAULT 0`; `created_at TEXT! DEFAULT datetime('now')`; `last_active_at TEXT! DEFAULT datetime('now')` | `idx_profiles_handle(handle)`; UNIQUE partial expression index `idx_profiles_owner_handle(owner_id,lower(handle)) WHERE owner_id IS NOT NULL`; PK | — |
| `push_subscriptions` | `endpoint_hash TEXT PK`; `profile_id TEXT!`; `owner_id TEXT!`; `endpoint TEXT!`; `p256dh TEXT!`; `auth TEXT!`; `created_at TEXT! DEFAULT datetime('now')`; `updated_at TEXT! DEFAULT datetime('now')` | `idx_push_subscriptions_profile(profile_id)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `rating_history` | `id INTEGER PK AUTOINCREMENT`; `handle TEXT!`; `contest_id INTEGER!`; `contest_name TEXT`; `rank INTEGER`; `rating_update_time INTEGER!`; `old_rating INTEGER!`; `new_rating INTEGER!` | UNIQUE `(handle,contest_id)`; PK | — |
| `review_queue` | `id TEXT PK`; `profile_id TEXT!`; `problem_id TEXT!`; `source TEXT! DEFAULT 'DAILY_STRUGGLE'`; `contest_id INTEGER`; `problem_index TEXT`; `problem_name TEXT!`; `rating INTEGER`; `tags TEXT! DEFAULT '[]'`; `trigger_reason TEXT!`; `added_at TEXT! DEFAULT datetime('now')`; `due_date TEXT!`; `interval_days INTEGER! DEFAULT 1`; `repetition_count INTEGER! DEFAULT 0`; `state TEXT! DEFAULT 'DUE'`; `last_reviewed_at TEXT`; `review_notes TEXT` | `idx_review_queue_profile_due(profile_id,due_date,state)`; UNIQUE `(profile_id,problem_id)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `settings` | `key TEXT PK`; `value TEXT!`; `updated_at TEXT! DEFAULT datetime('now')` | PK | — |
| `solve_sessions` | `id TEXT PK`; `profile_id TEXT!`; `problem_id TEXT!`; `problem_name TEXT`; `problem_rating INTEGER`; `tags TEXT! DEFAULT '[]'`; `started_at TEXT!`; `ended_at TEXT`; `duration_seconds INTEGER! DEFAULT 0`; `active_duration_seconds INTEGER! DEFAULT 0`; `hints_revealed INTEGER! DEFAULT 0`; `editorial_viewed INTEGER! DEFAULT 0`; `outcome TEXT! DEFAULT 'IN_PROGRESS'`; `verified_ac INTEGER! DEFAULT 0`; `perceived_difficulty TEXT`; `struggle_type TEXT`; `key_takeaway TEXT`; `reflection_notes TEXT`; `created_at TEXT! DEFAULT datetime('now')`; `updated_at TEXT! DEFAULT datetime('now')` | `idx_solve_sessions_profile(profile_id,started_at)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `submissions` | `id INTEGER PK`; `handle TEXT!`; `problem_id TEXT!`; `contest_id INTEGER`; `problem_index TEXT`; `verdict TEXT`; `creation_time INTEGER!`; `programming_language TEXT`; `raw_json TEXT` | `idx_submissions_handle_contest_index(handle,contest_id,problem_index)`; `idx_submissions_handle_verdict(handle,verdict)`; `idx_submissions_handle_problem(handle,problem_id)`; PK | — |
| `sync_leases` | `lease_key TEXT PK`; `owner_id TEXT!`; `acquired_at INTEGER!`; `expires_at INTEGER!` | PK | — |
| `sync_meta` | `key TEXT PK`; `value TEXT!`; `updated_at TEXT! DEFAULT datetime('now')` | PK | — |
| `user_contests` | `id TEXT PK`; `profile_id TEXT!`; `contest_id INTEGER!`; `name TEXT!`; `start_time_seconds INTEGER!`; `duration_seconds INTEGER DEFAULT 7200`; `participation_type TEXT! DEFAULT 'RATED'`; `rank INTEGER`; `old_rating INTEGER`; `new_rating INTEGER`; `rating_change INTEGER`; `problems_solved INTEGER DEFAULT 0`; `problems_attempted INTEGER DEFAULT 0`; `total_submissions INTEGER DEFAULT 0`; `penalties INTEGER DEFAULT 0`; `is_official INTEGER DEFAULT 1`; `report_json TEXT`; `created_at TEXT! DEFAULT datetime('now')`; `updated_at TEXT! DEFAULT datetime('now')` | `idx_user_contests_profile_contest(profile_id,contest_id)`; `idx_user_contests_profile(profile_id)`; UNIQUE `(profile_id,contest_id)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |
| `weekly_goals` | `id TEXT PK`; `profile_id TEXT!`; `week_start_date TEXT!`; `target_solves INTEGER! DEFAULT 15`; `target_contests INTEGER! DEFAULT 1`; `target_upsolves INTEGER! DEFAULT 3`; `focus_topics TEXT! DEFAULT '[]'`; `notes TEXT`; `updated_at TEXT! DEFAULT datetime('now')` | UNIQUE `(profile_id,week_start_date)`; PK | `profile_id → profiles.id ON DELETE CASCADE` |

`PRAGMA foreign_key_list` showed the relationships listed above; there are no other declared foreign keys in the active SQLite schema. Every declared FK uses `ON UPDATE NO ACTION` and `MATCH NONE` (SQLite's default), with `ON DELETE` actions as listed. SQLite does not enforce foreign keys unless enabled on each connection. Migration must run explicit orphan checks regardless of the connection setting.

### 3.2 Active data counts

| Table / record category | Rows | Additional observation |
|---|---:|---|
| `profiles` | 2 | Both `owner_id IS NULL`; 0 rows have a browser owner. No account ownership can be inferred from these records. |
| `daily_sets` / `daily_problems` | 2 / 6 | Existing user-owned training assignments. |
| `problem_learning_events` | 997 | All 997 have `verified_ac=1`; the audited source values use `VERIFIED_CODEFORCES`. No non-empty event notes. Preserve evidence and source; revalidate rather than infer identity from the handle. |
| `solve_sessions` | 0 | No server-side solve-session records. |
| `review_queue` / `contest_problem_reviews` | 0 / 0 | No current rows in these two review stores. |
| `weekly_goals` | 2 | Neither row has notes. |
| `user_contests` | 707 | No non-empty `report_json`. |
| `learner_profile_state` | 2 | One per local profile. |
| `problems` / `curriculum_problems` / `contest_problems_meta` | 11,482 / 30 / 0 | Shared catalog, curriculum seed, and empty contest-problem cache. |
| `codeforces_contests` | 2,167 | Shared contest metadata. |
| `submissions` / `rating_history` / `profile_cache` | 1,537 / 33 / 2 | Handle-keyed external/cache data, not proof of account or training-data ownership. |
| `sync_meta` / `sync_leases` | 15 / 1 | Operational metadata and one lease. Lease owner is not a user identity. |
| `notification_settings` / `push_subscriptions` / `notification_deliveries` | 0 / 0 / 0 | Local SQLite notification path currently has no rows. |
| `settings` | 2 | Values were not reproduced here; classify each key before migration. |

The root `data/cp_coach.db` had no application tables. The dated backup had 20 tables and the same row counts for overlapping tables at the prior audit point, but is stale and not verified for recovery. Compared with the active schema it lacks `notification_settings`, `push_subscriptions`, and `notification_deliveries`, and its `profiles` table lacks `owner_id`. Its profile index also differs: the backup has a global UNIQUE `handle` index, while the active database has a non-unique `handle` index plus a partial unique `(owner_id,lower(handle))` index for non-null owners. All other table/column/index inventories matched. Do not use it as the sole rollback source.

### 3.3 Supabase social migration schema

The uncommitted Supabase migration file currently present in the worktree creates 14 public tables. These are draft workspace definitions, not verified remote tables or verified data:

| Table | Columns / key fields | Constraints and indexes |
|---|---|---|
| `social_profiles` | `user_id`, `codeforces_handle`, `handle_verified_at`, `allow_friend_requests`, `show_cp_presence`, `show_last_active`, `notify_friend_requests`, `notify_new_posts`, `updated_at` | PK/FK to `auth.users`; handle syntax and handle/verification pairing checks; unique lower-case handle partial index. |
| `codeforces_link_challenges` | `user_id`, `handle`, `challenge_hash`, `expires_at`, `created_at` | PK/FK to Auth; handle check; expiry index. |
| `codeforces_credentials` | `user_id`, `ciphertext`, `nonce`, `auth_tag`, `updated_at` | PK/FK to social profile; nonce is 12 bytes and tag 16 bytes. |
| `codeforces_friends_cache` | `user_id`, `friend_handle`, `rating`, `last_online_time_seconds`, `is_online`, `refreshed_at` | Composite PK; user FK; online lookup index. |
| `friend_requests` | `id`, `sender_id`, `recipient_id`, `status`, `created_at`, `updated_at` | UUID PK; participant FKs; status check; no self-request; pending unordered-pair unique partial index; sender/recipient indexes. |
| `friendships` | `user_low_id`, `user_high_id`, `created_at` | Composite PK; participant FKs; canonical-order check; reverse lookup index. |
| `friend_presence` | `user_id`, `heartbeat_at`, `expires_at` | User PK/FK; expiry index. |
| `friend_activity_preferences` | `user_id`, `friend_id`, `notify_online`, `updated_at` | Composite PK/FKs; no-self check. |
| `blog_watchlist` | `user_id`, `handle`, `created_at` | Composite PK/FK; handle check. |
| `blog_entries` | `user_id`, `entry_id`, `author_handle`, `title`, `preview`, `tags`, `content_preview`, `article_text`, `detail_fetched_at`, `creation_time_seconds`, `synced_at` | Composite PK/FK; recent-entry and author indexes. |
| `blog_entry_comments` | `user_id`, `entry_id`, `comments`, `fetched_at` | Composite PK/FK to blog entry; JSON array check. |
| `blog_entry_state` | `user_id`, `entry_id`, `is_read`, `is_saved`, `personal_note`, `updated_at` | Composite PK/FK; personal-note length check. |
| `social_sync_state` | `user_id`, `friends_refreshed_at`, `blogs_refreshed_at`, `next_friends_refresh_at`, `next_blogs_refresh_at`, `last_error_code`, `updated_at` | User PK/FK; partial due indexes. |
| `social_notifications` | `id`, `user_id`, `event_key`, `kind`, `title`, `body`, `href`, `is_read`, `created_at` | UUID PK/FK; kind check; unique `(user_id,event_key)`; recent/unread indexes. |

It also defines `are_social_friends_with(uuid)`, a trigger protecting friend-request identity/state, RLS on all 14 tables, and grants to `authenticated`. Most policies require the custom `app.cp_coach_backend='true'` GUC. The backend sets both JWT-claim GUCs and that custom GUC after its own token verification, then sets `ROLE authenticated`. This code path is not a design to copy into the final authorization boundary: arbitrary custom PostgreSQL settings are not proof of a signed Supabase JWT, and the migration's public/friend profile policy and privileged sync paths need a separate policy review. The migration is non-idempotent in places and has no training schema or data migration.

Exact explicit social indexes are: `social_profiles_handle_casefold_idx(lower(codeforces_handle)) WHERE codeforces_handle IS NOT NULL`; `codeforces_link_challenges_expiry_idx(expires_at)`; `codeforces_friends_online_idx(user_id,is_online,friend_handle)`; `friend_requests_pending_pair_idx(LEAST(sender_id,recipient_id),GREATEST(sender_id,recipient_id)) WHERE status='pending'`; `friend_requests_recipient_pending_idx(recipient_id,created_at DESC) WHERE status='pending'`; `friend_requests_sender_idx(sender_id,created_at DESC)`; `friendships_high_user_idx(user_high_id,user_low_id)`; `friend_presence_expiry_idx(expires_at)`; `blog_entries_user_recent_idx(user_id,creation_time_seconds DESC)`; `blog_entries_user_author_idx(user_id,lower(author_handle),creation_time_seconds DESC)`; `social_sync_friends_due_idx(next_friends_refresh_at) WHERE next_friends_refresh_at IS NOT NULL`; `social_sync_blogs_due_idx(next_blogs_refresh_at) WHERE next_blogs_refresh_at IS NOT NULL`; `social_notifications_user_recent_idx(user_id,created_at DESC)`; and `social_notifications_user_unread_idx(user_id,created_at DESC) WHERE is_read=false`. Other uniqueness comes from the primary/composite keys and declared unique constraints in the table inventory.

### 3.4 Cloudflare D1 notification schema

The checked-in migration enables SQLite foreign keys and creates these six tables:

| Table | Exact fields and constraints |
|---|---|
| `notification_profiles` | `profile_id TEXT PK`; `owner_id TEXT!`; `cf_handle TEXT!`; `contest_reminders INTEGER! DEFAULT 0 CHECK 0/1`; `daily_reminders INTEGER! DEFAULT 0 CHECK 0/1`; `reminder_time TEXT! DEFAULT '20:00'` with format/hour checks; `timezone TEXT! DEFAULT 'Asia/Hebron' CHECK timezone='Asia/Hebron'`; `snapshot_date`; `daily_snapshot TEXT! DEFAULT '[]' CHECK json_valid`; `snapshot_synced_at`; `submissions_checked_at`; `verification_retry_after`; `created_at`/`updated_at TEXT!` timestamp defaults; UNIQUE `(profile_id,owner_id)`. |
| `notification_subscriptions` | `endpoint_hash TEXT PK` with 64-char check; `profile_id TEXT!`; `owner_id TEXT!`; `endpoint TEXT!`; `p256dh TEXT!`; `auth TEXT!`; `active INTEGER! DEFAULT 1 CHECK 0/1`; `created_at`/`updated_at`; composite FK `(profile_id,owner_id)` to notification profile with cascade. |
| `notification_contests` | `contest_id INTEGER PK`; `platform TEXT! DEFAULT 'Codeforces' CHECK`; `name TEXT!`; `start_time_seconds INTEGER!`; `duration_seconds`; `phase TEXT!`; `updated_at TEXT!`. |
| `notification_deliveries` | `delivery_id TEXT PK`; `profile_id TEXT!`; `endpoint_hash TEXT!`; `notification_key TEXT!`; `status TEXT! CHECK CLAIMED/SENT/FAILED/EXPIRED`; `claimed_at TEXT!`; `sent_at`; `retry_after`; `error_code`; `created_at TEXT!`; UNIQUE `(profile_id,endpoint_hash,notification_key)`; FK profile cascade. |
| `notification_worker_state` | `singleton INTEGER PK CHECK singleton=1`; contest refresh, lock owner/expiry, run timestamps, status. Migration inserts singleton row 1. |
| `notification_worker_runs` | `run_id TEXT PK`; start/completion; status check RUNNING/SUCCEEDED/FAILED/SKIPPED; profile/push/sent counts default 0; duration; error code. |

Exact indexes: `idx_notification_profiles_daily_due(daily_reminders,reminder_time,profile_id)`; `idx_notification_profiles_contest_due(contest_reminders,profile_id)`; `idx_notification_subscriptions_profile_active(profile_id,endpoint_hash) WHERE active=1`; `idx_notification_contests_upcoming(start_time_seconds,contest_id) WHERE phase='BEFORE'`; `idx_notification_deliveries_pending(status,retry_after,claimed_at)`; `idx_notification_deliveries_profile_key(profile_id,notification_key,endpoint_hash)`; `idx_notification_deliveries_created(created_at)`; and `idx_notification_worker_runs_started(started_at DESC)`. The D1 store performs profile ensure/update, subscription CRUD, snapshot replacement, contest refresh, due-task selection, delivery claims/retries, and run/lock tracking. Its HTTP API accepts a shared secret and a client-supplied profile/owner/handle tuple; it is service-to-service protection, not canonical user authentication. D1 row counts and the deployed worker version remain unknown.

## 4. Data ownership map and source-to-target mapping

Target user identity is the UUID from `auth.users`. A `training_profiles` row is a Codeforces-linked training context owned by that Auth user. Child rows include both `user_id` and `training_profile_id` so composite foreign keys can prevent cross-owner references. Codeforces handles are external identifiers only; never use them to assign local records.

| Source table / field mapping | Target | Ownership / transformation |
|---|---|---|
| SQLite `profiles.id` → `training_profiles.id`; `handle` → `codeforces_handle`; `owner_id` → `user_id` only through approved claim crosswalk; `display_name`, `avatar`, `rating`, `max_rating`, `rank`, `max_rank`, `created_at`, `last_active_at` map by name; `is_default` → `user_preferences.default_training_profile_id` after confirming a single default | `training_profiles` and `user_preferences` | Profile owner is resolved independently of handle. Preserve source profile ID in a restricted migration crosswalk. |
| SQLite `settings.key/value/updated_at` | `user_preferences` or deployment config | Classify every key. Move per-user choices only; never import global secrets/operational settings as user data. If a key represents the active profile, map its value to `user_preferences.active_training_profile_id` only after ownership mapping. |
| `daily_sets.id/profile_id/date/generated_at` | `daily_sets.id/training_profile_id/local_date/generated_at` | Add mapped `user_id`; map `id` through the restricted ID crosswalk; unique profile/date. Keep `date` as a local calendar date, not a UTC timestamp. |
| `daily_problems.id/daily_set_id/profile_id/daily_set_date/problem_id/category/reason/target_rating/completed/solved_status/perceived_difficulty/time_spent_minutes/notes/updated_at/verified_cf_ac/educational_source/educational_source_url/curriculum_stage/learning_objective/prerequisites/struggle_reason/is_opened/opened_at/attempted/self_reported_solved/difficulty_experience/solution_method/problem_opinion` | `daily_problems` (same names except `profile_id` → `training_profile_id`; add `user_id`; text IDs → UUID mapping; integer flags → boolean) | Preserve all feedback and evidence. Convert `prerequisites` JSON text to validated JSONB only after parsing; preserve unknown values in staging. `daily_set_id` and `problem_id` must resolve. |
| `problems.id/contest_id/problem_index/name/type/rating/tags/solved_count/updated_at` | `problems.problem_id/contest_id/problem_index/name/problem_type/rating/tags/solved_count/updated_at` | Shared external catalog. Validate canonical key against contest/index; parse `tags` JSON text to `text[]`; numeric counts may widen to bigint. |
| `curriculum_problems.id/problem_id/source/source_url/name/curriculum_stage/topic/target_rating/learning_objective/prerequisites/cf_contest_id/cf_index/created_at` | `curriculum_problems` (same names) | Shared curated data. Parse prerequisites JSON text to JSONB; widen `cf_contest_id`; validate source URLs, rating, and version. Keep authored curriculum distinct from user content. |
| `learner_profile_state.profile_id/handle/data_json/updated_at` | `learner_profile_state.training_profile_id/data/updated_at`; add `user_id` and `schema_version` | `profile_id` maps via crosswalk; validate `handle` against the already-mapped training profile but do not use it to create the mapping. Preserve JSON as JSONB with schema version; do not drop unknown keys. |
| `problem_learning_events.id/profile_id/problem_id/source/problem_name/contest_id/problem_index/rating/tags/solved_status/perceived_difficulty/struggle_reason/notes/verified_ac/hints_revealed/editorial_viewed/source_key/occurred_at/difficulty_experience/solution_method/problem_opinion` | `problem_learning_events` (same names except IDs map to UUID/profile key; `tags` text → `text[]`; integer flags → boolean); add `user_id` | Preserve source, stable key, evidence, problem snapshots, and timestamp. Dedupe on `(training_profile_id,source_key)` after collision report; do not count journal backfills twice. |
| `solve_sessions.id/profile_id/problem_id/problem_name/problem_rating/tags/started_at/ended_at/duration_seconds/active_duration_seconds/hints_revealed/editorial_viewed/outcome/verified_ac/perceived_difficulty/struggle_type/key_takeaway/reflection_notes/created_at/updated_at` | `solve_sessions` (same names except IDs map to UUID/profile key; `tags` text → `text[]`; `editorial_viewed`/`verified_ac` integer → boolean); add `user_id` | Preserve session ID through the mapping ledger, timestamps, durations, outcome, hints/editorial, and reflections. No current rows. |
| `review_queue.id/profile_id/problem_id/source/contest_id/problem_index/problem_name/rating/tags/trigger_reason/added_at/due_date/interval_days/repetition_count/state/last_reviewed_at/review_notes` | `review_queue` (same names except `profile_id` → `training_profile_id`, IDs map to UUID, `tags` text → `text[]`, `added_at` timestamptz, `due_date` date); add `user_id` | Keep one current schedule per profile/problem. Current table is not historical review evidence. No current rows. |
| Future `review_events` | `review_events` | No source rows; create for future actions only. Do not manufacture history from current queue state. |
| `weekly_goals.id/profile_id/week_start_date/target_solves/target_contests/target_upsolves/focus_topics/notes/updated_at` | `weekly_goals` (same names except `profile_id` → `training_profile_id`, ID maps to UUID, `focus_topics` text → `text[]`); add `user_id` | Preserve local week date, targets, topics and notes; parse focus JSON. |
| `user_contests.id/profile_id/contest_id/name/start_time_seconds/duration_seconds/participation_type/rank/old_rating/new_rating/rating_change/problems_solved/problems_attempted/total_submissions/penalties/is_official/report_json/created_at/updated_at` | `contest_participation` (same fields except profile/ID mapping and `report_json` → `report` JSONB; integer flags → boolean); add `user_id` | Preserve participation type and result/report JSON. Validate contest/date and collision `(profile,contest)`. |
| `contest_problem_reviews.id/profile_id/contest_id/problem_index/self_review_tag/self_review_notes/upsolve_status/upsolved_submission_id/updated_at` | `contest_problem_reviews` (same fields except profile/ID mapping; widen submission ID to bigint); add `user_id` | Preserve upsolve status, submission ID and notes. Validate any `upsolved_submission_id`; no rows currently. |
| `contest_problems_meta.id/contest_id/problem_index/name/rating/tags/cf_url` | `contest_problem_metadata.contest_id/problem_index/name/rating/tags/cf_url` | Shared cache; composite target key `(contest_id,problem_index)`. `id` is redundant only after validating it against the canonical contest/index key; otherwise retain it in staging/crosswalk. Parse tags JSON. |
| `codeforces_contests.contest_id/name/start_time_seconds/duration_seconds/phase/updated_at` | `codeforces_contests` (same names) | Shared external reference/cache. Preserve source timestamp; refresh only after import comparison. |
| `submissions.id/handle/problem_id/contest_id/problem_index/verdict/creation_time/programming_language/raw_json` | `codeforces_submissions.submission_id/handle/problem_id/contest_id/problem_index/verdict/creation_time_seconds/programming_language/raw_json` | Shared/public cache keyed by submission ID and handle; rename time field, parse raw JSON to JSONB after validation, preserve external ID only under retention policy. No ownership inference from handle. |
| `rating_history.id/handle/contest_id/contest_name/rank/rating_update_time/old_rating/new_rating` | `codeforces_rating_history.handle/contest_id/contest_name/rank/rating_update_time_seconds/old_rating/new_rating` | Shared public cache keyed by handle/contest. `id` is source-only; retain it in staging until target uniqueness/collisions are validated. |
| `profile_cache.handle/rating/max_rating/rank/max_rank/avatar/title_photo/organization/city/country/raw_json/updated_at` | `codeforces_profile_cache` (same names) | Rebuildable public cache. Parse `raw_json` to JSONB; minimize retention; no direct user ownership. |
| `sync_meta.key/value/updated_at` | `codeforces_sync_state.sync_key/handle/last_synced_at/next_sync_at/last_error_code/updated_at` | Normalize only understood key/value formats; retain unknown keys in a migration report/staging table for owner review. Do not import global process settings blindly. |
| `sync_leases.lease_key/owner_id/acquired_at/expires_at` | Worker lease/advisory lock | Ephemeral state; do not import expired leases or map owner to Auth. Prefer Postgres advisory lock or short lease. |
| SQLite `notification_settings.profile_id/contest_reminders/daily_reminders/reminder_time/updated_at` | `notification_preferences.training_profile_id/contest_reminders/daily_reminders/reminder_time/updated_at`; add `user_id`; reminder toggles integer → boolean, text time → `time` | SQLite currently has zero rows. Map only with authenticated ownership crosswalk. |
| SQLite `push_subscriptions.endpoint_hash/profile_id/owner_id/endpoint/p256dh/auth/created_at/updated_at` | `push_subscriptions.endpoint_hash/training_profile_id/user_id/endpoint/p256dh/auth_secret/created_at/updated_at` | Map owner only through approved claim; never copy legacy owner ID to Auth UUID. Resolve endpoint-hash collisions explicitly. |
| SQLite `notification_deliveries.id/profile_id/endpoint_hash/notification_key/status/attempted_at/sent_at/retry_after` | `notification_deliveries` plus `notifications.event_key` | Preserve key/status/times. Map legacy `notification_key` to a stable `notifications.event_key`, create a target notification-ID crosswalk, and retain source delivery ID in migration staging. |
| D1 `notification_profiles.profile_id/owner_id/cf_handle/contest_reminders/daily_reminders/reminder_time/timezone/snapshot_date/daily_snapshot/snapshot_synced_at/submissions_checked_at/verification_retry_after/created_at/updated_at` | `notification_preferences` plus derived daily schedule | D1 contents unknown. Profile/owner mapping requires claim; discard/rebuild snapshot only after comparing it with authoritative assignments. Keep operational timestamps only if needed for safe retry. |
| D1 `notification_subscriptions.endpoint_hash/profile_id/owner_id/endpoint/p256dh/auth/active/created_at/updated_at` | `push_subscriptions` | Preserve endpoint, endpoint hash, p256dh/auth, active flag, timestamps after profile-owner crosswalk; resolve global endpoint collisions explicitly. |
| D1 `notification_contests.contest_id/platform/name/start_time_seconds/duration_seconds/phase/updated_at` | `codeforces_contests` / notification schedule cache | Rebuildable public cache, not user data. |
| D1 `notification_deliveries.delivery_id/profile_id/endpoint_hash/notification_key/status/claimed_at/sent_at/retry_after/error_code/created_at` | `notification_deliveries` | Map `delivery_id` to target UUID/crosswalk, `claimed_at` to `attempted_at`, preserve other delivery fields. Reconcile SQLite/D1 ledgers before enabling the new sender. |
| D1 `notification_worker_state.singleton/last_contest_refresh_at/lock_owner/lock_expires_at/last_started_at/last_completed_at/last_success_at/last_status` | Postgres worker lease plus `notification_worker_runs` | Do not transfer a stale lock or singleton; retain only operational refresh/run timestamps if useful. |
| D1 `notification_worker_runs.run_id/started_at/completed_at/status/profiles_checked/pushes_attempted/notifications_sent/duration_ms/error_code` | `notification_worker_runs` | Map run ID to UUID/crosswalk; preserve bounded run history/status/counts/times. |
| Existing Supabase social tables | Same social tables, keyed by existing `auth.users.id` | Remote state unknown. Preserve UUIDs only if this exact Auth project remains canonical. Validate encrypted credential key availability before re-encryption. |
| Browser `cp-coach:knowledge-journal:v1:<handle>` | `journal_entries` (or a typed journal table) | User-export/import from original browser required; convert `title/lesson/problemRef/contestId/topics/createdAt/updatedAt`; map only after explicit account claim. |
| Browser `cp-coach:virtual-contest:v1:<handle>:<contestId>` | `virtual_contest_sessions` and child problem events | User-export/import required; preserve contest ID/name/duration/timestamps/problem events. Handle is validation metadata, not owner mapping. |
| Browser context/offline snapshots and JSON backups | Versioned import staging then mapped tables | Use version-aware validation and conflict reporting. Never silently replace newer server notes with stale local data. |

### Records not recoverable from a server-only export

Knowledge journal notes, virtual contest sessions, unsynced context, and any localStorage backups exist only in the original browser when not previously imported. The actual browser records were not inspected, so their count is unknown. If the browser is cleared, lost, or inaccessible before user export, those records cannot be reconstructed from SQLite, Supabase, or D1. Browser localStorage is origin-specific and is not included in server backups.

## 5. Authentication transition and safe account claim

### 5.1 Target request identity

1. Supabase Auth issues the canonical user UUID and signed access token.
2. The Node API validates the bearer token with Supabase Auth. For ordinary data operations it forwards that same user JWT to Supabase PostgREST (using the public/anon project key), so Postgres receives the authenticated JWT context and `auth.uid()` is derived from the verified token.
3. RLS is the database enforcement layer. The API also validates request shape and business rules, but never substitutes a client-supplied `user_id` or `profile_id` for the token subject.
4. Do not use a Supabase service-role key for normal user requests. Do not authorize from a caller-controlled `user_id`, a custom GUC, Codeforces handle, or `X-Coach-Client-Id`.
5. For operations that need a transaction, expose narrowly scoped `SECURITY INVOKER` RPCs under the caller JWT, or use PostgREST transactions. Privileged migration and worker tasks use separate restricted credentials/roles and audited procedures.

### 5.2 Claiming legacy records

**Browser-owned public profiles:** require a fresh authenticated session plus proof of control of the original browser's high-entropy client identifier. Use a single-use, short-lived server challenge bound to the exact legacy owner/profile IDs; store only a cryptographic hash of the proof; rate-limit and audit attempts; consume the challenge atomically. The legacy browser proves possession over an authenticated HTTPS request. Require a second user confirmation showing the profile/history being attached. This proves continuity of the browser-held legacy token, not Codeforces account ownership. If the original browser/export is unavailable, quarantine the records for explicit manual resolution.

**Local profiles with `owner_id IS NULL`:** there is no existing claim token. Require an operator-approved, per-profile mapping to an authenticated user based on verified local custody or an owner-supplied signed export. Do not automatically claim, merge, or assign by Codeforces handle. If two profiles or exports conflict, preserve both until the owner chooses.

**Browser-only records:** import from the original browser or its validated backup while authenticated. Attach only after the user previews and confirms the imported set. Validate the existing version, all timestamps and ID collisions; retain a source checksum/import record. A Codeforces handle match is insufficient.

**Suggested private claim record:** `app_private.legacy_claim_challenges(id uuid, source_kind text, legacy_owner_hash bytea, legacy_profile_hash bytea, target_user_id uuid REFERENCES auth.users, proof_hash bytea, expires_at timestamptz, consumed_at timestamptz, created_at timestamptz)`. No direct `anon`/`authenticated` table grants. A narrow RPC must check `auth.uid() = target_user_id`, expiry, one-time consumption, and the verified proof; the local null-owner pathway uses a separately approved migration mapping, not this public claim endpoint.

## 6. Proposed PostgreSQL schema draft

This draft favors explicit user ownership, composite foreign keys, and immutable external IDs. `user_id` is repeated on profile-owned child rows to let foreign keys and RLS independently enforce that the profile belongs to the same user. The existing social migration remains the field-shape starting point for its 14 tables; policies must be replaced/reviewed as specified below. This SQL is illustrative and has not been applied or tested against a Supabase project.

### 6.1 Core, training, Codeforces, and notification DDL

```sql
-- Auth is canonical. A user profile is not a training profile.
CREATE TABLE public.user_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.training_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  codeforces_handle text NOT NULL,
  display_name text,
  avatar text,
  rating integer,
  max_rating integer,
  rank text,
  max_rank text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX training_profiles_user_handle_idx
  ON public.training_profiles(user_id, lower(codeforces_handle));
CREATE INDEX training_profiles_user_idx ON public.training_profiles(user_id, created_at);

CREATE TABLE public.user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC',
  default_training_profile_id uuid,
  active_training_profile_id uuid,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(preferences) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (default_training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (active_training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE public.problems (
  problem_id text PRIMARY KEY,
  contest_id bigint NOT NULL,
  problem_index text NOT NULL,
  name text NOT NULL,
  problem_type text,
  rating integer,
  tags text[] NOT NULL DEFAULT '{}',
  solved_count bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contest_id, problem_index)
);
CREATE INDEX problems_rating_idx ON public.problems(rating);

CREATE TABLE public.curriculum_problems (
  id text PRIMARY KEY,
  problem_id text NOT NULL,
  source text NOT NULL,
  source_url text NOT NULL,
  name text NOT NULL,
  curriculum_stage text NOT NULL,
  topic text NOT NULL,
  target_rating integer NOT NULL,
  learning_objective text NOT NULL,
  prerequisites jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(prerequisites) = 'array'),
  cf_contest_id bigint,
  cf_index text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX curriculum_problems_rating_idx ON public.curriculum_problems(target_rating);
CREATE INDEX curriculum_problems_topic_idx ON public.curriculum_problems(topic);

CREATE TABLE public.codeforces_contests (
  contest_id bigint PRIMARY KEY,
  name text NOT NULL,
  start_time_seconds bigint NOT NULL,
  duration_seconds bigint,
  phase text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX codeforces_contests_upcoming_idx
  ON public.codeforces_contests(start_time_seconds) WHERE phase = 'BEFORE';

CREATE TABLE public.contest_problem_metadata (
  contest_id bigint NOT NULL,
  problem_index text NOT NULL,
  name text NOT NULL,
  rating integer,
  tags text[] NOT NULL DEFAULT '{}',
  cf_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contest_id, problem_index)
);

CREATE TABLE public.daily_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  local_date date NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_profile_id, local_date),
  UNIQUE (id, user_id, training_profile_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX daily_sets_user_date_idx
  ON public.daily_sets(user_id, local_date DESC);

CREATE TABLE public.daily_problems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  daily_set_id uuid NOT NULL,
  problem_id text NOT NULL REFERENCES public.problems(problem_id),
  daily_set_date date NOT NULL,
  category text NOT NULL,
  reason text NOT NULL,
  target_rating integer NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  solved_status text,
  perceived_difficulty text,
  time_spent_minutes integer CHECK (time_spent_minutes BETWEEN 0 AND 1440),
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_cf_ac boolean NOT NULL DEFAULT false,
  educational_source text,
  educational_source_url text,
  curriculum_stage text,
  learning_objective text,
  prerequisites jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(prerequisites) = 'array'),
  struggle_reason text,
  is_opened boolean NOT NULL DEFAULT false,
  opened_at timestamptz,
  attempted boolean NOT NULL DEFAULT false,
  self_reported_solved boolean NOT NULL DEFAULT false,
  difficulty_experience text,
  solution_method text,
  problem_opinion text,
  UNIQUE (daily_set_id, problem_id),
  UNIQUE (id, user_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (daily_set_id, user_id, training_profile_id)
    REFERENCES public.daily_sets(id, user_id, training_profile_id) ON DELETE CASCADE
);
CREATE INDEX daily_problems_user_date_idx
  ON public.daily_problems(user_id, daily_set_date DESC);
CREATE INDEX daily_problems_profile_idx
  ON public.daily_problems(training_profile_id, daily_set_date DESC);

CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  source_note_id text,
  title text NOT NULL,
  lesson text NOT NULL,
  problem_ref text,
  contest_id bigint,
  topics text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at),
  UNIQUE (training_profile_id, source_note_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX journal_entries_profile_updated_idx
  ON public.journal_entries(training_profile_id, updated_at DESC);

CREATE TABLE public.virtual_contest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  contest_id bigint NOT NULL,
  source_session_id text,
  name text NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds > 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (training_profile_id, contest_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX virtual_contest_sessions_profile_time_idx
  ON public.virtual_contest_sessions(training_profile_id, started_at DESC);

CREATE TABLE public.virtual_contest_problem_events (
  session_id uuid NOT NULL REFERENCES public.virtual_contest_sessions(id) ON DELETE CASCADE,
  problem_index text NOT NULL,
  first_started_at timestamptz,
  solved_at timestamptz,
  PRIMARY KEY (session_id, problem_index),
  CHECK (solved_at IS NULL OR first_started_at IS NOT NULL),
  CHECK (solved_at IS NULL OR solved_at >= first_started_at)
);

CREATE TABLE public.learner_profile_state (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (training_profile_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);

CREATE TABLE public.problem_learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  problem_id text NOT NULL,
  source text NOT NULL,
  problem_name text,
  contest_id bigint,
  problem_index text,
  rating integer,
  tags text[] NOT NULL DEFAULT '{}',
  solved_status text,
  perceived_difficulty text,
  struggle_reason text,
  notes text,
  verified_ac boolean NOT NULL DEFAULT false,
  hints_revealed integer,
  editorial_viewed boolean,
  source_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  difficulty_experience text,
  solution_method text,
  problem_opinion text,
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX problem_learning_source_key_idx
  ON public.problem_learning_events(training_profile_id, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX problem_learning_profile_time_idx
  ON public.problem_learning_events(training_profile_id, occurred_at DESC);
CREATE INDEX problem_learning_problem_time_idx
  ON public.problem_learning_events(training_profile_id, problem_id, occurred_at DESC);

CREATE TABLE public.solve_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  problem_id text NOT NULL,
  problem_name text,
  problem_rating integer,
  tags text[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  active_duration_seconds integer NOT NULL DEFAULT 0 CHECK (active_duration_seconds >= 0),
  hints_revealed integer NOT NULL DEFAULT 0 CHECK (hints_revealed >= 0),
  editorial_viewed boolean NOT NULL DEFAULT false,
  outcome text NOT NULL DEFAULT 'IN_PROGRESS',
  verified_ac boolean NOT NULL DEFAULT false,
  perceived_difficulty text,
  struggle_type text,
  key_takeaway text,
  reflection_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX solve_sessions_profile_time_idx
  ON public.solve_sessions(training_profile_id, started_at DESC);

CREATE TABLE public.review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  problem_id text NOT NULL,
  source text NOT NULL DEFAULT 'DAILY_STRUGGLE',
  contest_id bigint,
  problem_index text,
  problem_name text NOT NULL,
  rating integer,
  tags text[] NOT NULL DEFAULT '{}',
  trigger_reason text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  due_date date NOT NULL,
  interval_days integer NOT NULL DEFAULT 1 CHECK (interval_days > 0),
  repetition_count integer NOT NULL DEFAULT 0 CHECK (repetition_count >= 0),
  state text NOT NULL DEFAULT 'DUE',
  last_reviewed_at timestamptz,
  review_notes text,
  UNIQUE (training_profile_id, problem_id),
  UNIQUE (id, training_profile_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX review_queue_due_idx
  ON public.review_queue(training_profile_id, due_date, state);

CREATE TABLE public.review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  review_id uuid,
  problem_id text NOT NULL,
  outcome text NOT NULL,
  notes text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (review_id, training_profile_id)
    REFERENCES public.review_queue(id, training_profile_id) ON DELETE SET NULL (review_id)
);
CREATE INDEX review_events_profile_time_idx
  ON public.review_events(training_profile_id, reviewed_at DESC);

CREATE TABLE public.weekly_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  week_start_date date NOT NULL,
  target_solves integer NOT NULL DEFAULT 15 CHECK (target_solves >= 0),
  target_contests integer NOT NULL DEFAULT 1 CHECK (target_contests >= 0),
  target_upsolves integer NOT NULL DEFAULT 3 CHECK (target_upsolves >= 0),
  focus_topics text[] NOT NULL DEFAULT '{}',
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_profile_id, week_start_date),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);

CREATE TABLE public.codeforces_submissions (
  submission_id bigint PRIMARY KEY,
  handle text NOT NULL,
  problem_id text NOT NULL,
  contest_id bigint,
  problem_index text,
  verdict text,
  creation_time_seconds bigint NOT NULL,
  programming_language text,
  raw_json jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cf_submissions_handle_problem_idx
  ON public.codeforces_submissions(handle, problem_id);
CREATE INDEX cf_submissions_handle_verdict_idx
  ON public.codeforces_submissions(handle, verdict);
CREATE INDEX cf_submissions_contest_problem_idx
  ON public.codeforces_submissions(handle, contest_id, problem_index);

CREATE TABLE public.codeforces_rating_history (
  handle text NOT NULL,
  contest_id bigint NOT NULL,
  contest_name text,
  rank bigint,
  rating_update_time_seconds bigint NOT NULL,
  old_rating integer NOT NULL,
  new_rating integer NOT NULL,
  PRIMARY KEY (handle, contest_id)
);

CREATE TABLE public.codeforces_profile_cache (
  handle text PRIMARY KEY,
  rating integer,
  max_rating integer,
  rank text,
  max_rank text,
  avatar text,
  title_photo text,
  organization text,
  city text,
  country text,
  raw_json jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.contest_participation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  contest_id bigint NOT NULL,
  name text NOT NULL,
  start_time_seconds bigint NOT NULL,
  duration_seconds bigint NOT NULL DEFAULT 7200,
  participation_type text NOT NULL DEFAULT 'RATED',
  rank bigint,
  old_rating integer,
  new_rating integer,
  rating_change integer,
  problems_solved integer NOT NULL DEFAULT 0,
  problems_attempted integer NOT NULL DEFAULT 0,
  total_submissions integer NOT NULL DEFAULT 0,
  penalties integer NOT NULL DEFAULT 0,
  is_official boolean NOT NULL DEFAULT true,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_profile_id, contest_id),
  FOREIGN KEY (contest_id) REFERENCES public.codeforces_contests(contest_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX contest_participation_profile_idx
  ON public.contest_participation(training_profile_id, start_time_seconds DESC);

CREATE TABLE public.contest_problem_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  contest_id bigint NOT NULL,
  problem_index text NOT NULL,
  self_review_tag text,
  self_review_notes text,
  upsolve_status text NOT NULL DEFAULT 'UNSOLVED',
  upsolved_submission_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_profile_id, contest_id, problem_index),
  FOREIGN KEY (contest_id) REFERENCES public.codeforces_contests(contest_id),
  FOREIGN KEY (upsolved_submission_id)
    REFERENCES public.codeforces_submissions(submission_id) ON DELETE SET NULL,
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX contest_problem_reviews_profile_idx
  ON public.contest_problem_reviews(training_profile_id, contest_id);

CREATE TABLE public.codeforces_sync_state (
  sync_key text PRIMARY KEY,
  handle text,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX codeforces_sync_due_idx ON public.codeforces_sync_state(next_sync_at);

CREATE TABLE public.notification_preferences (
  training_profile_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contest_reminders boolean NOT NULL DEFAULT false,
  daily_reminders boolean NOT NULL DEFAULT false,
  reminder_time time NOT NULL DEFAULT '20:00',
  timezone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX notification_preferences_user_idx
  ON public.notification_preferences(user_id, training_profile_id);

CREATE TABLE public.push_subscriptions (
  endpoint_hash text PRIMARY KEY CHECK (endpoint_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX push_subscriptions_active_idx
  ON public.push_subscriptions(training_profile_id, endpoint_hash) WHERE active;
CREATE INDEX push_subscriptions_user_idx
  ON public.push_subscriptions(user_id, training_profile_id);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  training_profile_id uuid NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (training_profile_id, event_key),
  UNIQUE (id, training_profile_id),
  FOREIGN KEY (training_profile_id, user_id)
    REFERENCES public.training_profiles(id, user_id) ON DELETE CASCADE
);
CREATE INDEX notifications_due_idx
  ON public.notifications(status, next_attempt_at, scheduled_at);
CREATE INDEX notifications_user_recent_idx
  ON public.notifications(user_id, created_at DESC);

CREATE TABLE public.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL,
  training_profile_id uuid NOT NULL,
  endpoint_hash text NOT NULL,
  notification_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('CLAIMED','SENT','FAILED','EXPIRED')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  retry_after timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code text,
  UNIQUE (training_profile_id, endpoint_hash, notification_key),
  FOREIGN KEY (notification_id, training_profile_id)
    REFERENCES public.notifications(id, training_profile_id) ON DELETE CASCADE
);
CREATE INDEX notification_deliveries_retry_idx
  ON public.notification_deliveries(status, retry_after, attempted_at);

CREATE TABLE public.notification_worker_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  profiles_checked integer NOT NULL DEFAULT 0,
  pushes_attempted integer NOT NULL DEFAULT 0,
  notifications_sent integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error_code text
);
CREATE INDEX notification_worker_runs_started_idx
  ON public.notification_worker_runs(started_at DESC);
```

`contest_participation` is the proposed target name for SQLite `user_contests`. If compatibility is more valuable than renaming, retain `user_contests` in both migration and API; do not support two durable tables. The source `problem_id` is text and may not always match a valid Codeforces key, so migration must validate it before adding strict target FKs. Add any stricter FK only after orphan and collision reports pass.

### 6.2 Social, coaching, group, assignment, and progress schema

Keep the existing social table field definitions from the uncommitted workspace draft as a starting point: the 14 tables in §3.3, retaining their current primary/foreign keys, unique indexes, status checks, and cache indexes. Replace—not layer on top of—the custom-GUC-only policies. Use `auth.uid()` from the signed Supabase JWT for self ownership; friend-visible profile/presence reads must be limited to explicit non-secret columns and opt-in flags. Never expose `codeforces_credentials.ciphertext`, `nonce`, or `auth_tag` to friend reads.

```sql
CREATE TABLE public.coach_student_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  student_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACCEPTED','REJECTED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (coach_user_id <> student_user_id),
  CHECK (requested_by IN (coach_user_id, student_user_id)),
  UNIQUE (coach_user_id, student_user_id),
  UNIQUE (id, coach_user_id, student_user_id)
);
CREATE INDEX coach_student_student_idx
  ON public.coach_student_relationships(student_user_id, status);
CREATE INDEX coach_student_coach_idx
  ON public.coach_student_relationships(coach_user_id, status);

CREATE TABLE public.training_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, coach_user_id)
);
CREATE INDEX training_groups_coach_idx ON public.training_groups(coach_user_id);

CREATE TABLE public.training_group_memberships (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_role text NOT NULL CHECK (member_role IN ('COACH','STUDENT')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES public.training_groups(id) ON DELETE CASCADE
);
CREATE INDEX group_memberships_user_idx
  ON public.training_group_memberships(user_id, group_id);

CREATE TABLE public.training_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  coach_user_id uuid NOT NULL,
  student_user_id uuid NOT NULL,
  title text NOT NULL,
  instructions text,
  problem_id text REFERENCES public.problems(problem_id),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','SUBMITTED','REVIEWED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, student_user_id),
  FOREIGN KEY (group_id, coach_user_id)
    REFERENCES public.training_groups(id, coach_user_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, student_user_id)
    REFERENCES public.training_group_memberships(group_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, coach_user_id)
    REFERENCES public.training_group_memberships(group_id, user_id) ON DELETE CASCADE
);
CREATE INDEX training_assignments_student_due_idx
  ON public.training_assignments(student_user_id, due_at, status);
CREATE INDEX training_assignments_group_idx
  ON public.training_assignments(group_id, created_at DESC);

CREATE TABLE public.assignment_progress (
  assignment_id uuid NOT NULL,
  student_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED','REVIEWED')),
  response jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response) = 'object'),
  student_notes text,
  coach_feedback text,
  started_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id),
  FOREIGN KEY (assignment_id, student_user_id)
    REFERENCES public.training_assignments(id, student_user_id) ON DELETE CASCADE
);
CREATE INDEX assignment_progress_student_idx
  ON public.assignment_progress(student_user_id, updated_at DESC);
```

The group/assignment draft needs a DDL review before use: membership role and accepted coach/student relationship must be verified by constraints or narrow RPCs, not trusted from a submitted row. In particular, a group owner must be added as a `COACH` membership atomically, and a student assignment must require an accepted relationship plus a `STUDENT` membership. The composite FKs prevent cross-group references; triggers/RPC validation must enforce the role/status predicates.

### 6.3 RLS, grants, and database roles

**User-facing table policy pattern:** enable RLS on every user-owned table. For `user_profiles`, use `user_id = (SELECT auth.uid())`. For training-profile rows, use `user_id = (SELECT auth.uid())`. For all child training tables, use the same `user_id` condition and retain the composite FKs from §6.1. The policy must constrain both existing and proposed rows:

```sql
ALTER TABLE public.training_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_profiles_owner_all ON public.training_profiles
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER TABLE public.daily_problems ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_problems_owner_all ON public.daily_problems
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
```

The following draft applies that exact owner policy to every user-owned row table (the policy is created from a fixed, reviewed table-name list; this block is not applied):

```sql
DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'user_profiles', 'training_profiles', 'user_preferences',
    'daily_sets', 'daily_problems', 'journal_entries',
    'virtual_contest_sessions', 'learner_profile_state',
    'problem_learning_events', 'solve_sessions', 'review_queue',
    'review_events', 'weekly_goals', 'contest_participation',
    'contest_problem_reviews', 'notification_preferences',
    'push_subscriptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
       USING (user_id = (SELECT auth.uid()))
       WITH CHECK (user_id = (SELECT auth.uid()))',
      table_name || '_owner_all', table_name
    );
  END LOOP;
END
$policies$;

ALTER TABLE public.virtual_contest_problem_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY virtual_contest_events_owner_all
  ON public.virtual_contest_problem_events FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.virtual_contest_sessions s
    WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.virtual_contest_sessions s
    WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())
  ));

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_deliveries_owner_read
  ON public.notification_deliveries FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.notifications n
    WHERE n.id = notification_id
      AND n.training_profile_id = notification_deliveries.training_profile_id
      AND n.user_id = (SELECT auth.uid())
  ));

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_owner_read
  ON public.notifications FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- These roles are provisioned separately with NOBYPASSRLS and no table ownership.
CREATE POLICY notification_worker_preferences_read
  ON public.notification_preferences FOR SELECT TO notification_worker USING (true);
CREATE POLICY notification_worker_subscriptions_read
  ON public.push_subscriptions FOR SELECT TO notification_worker USING (active);
CREATE POLICY notification_worker_jobs_read
  ON public.notifications FOR SELECT TO notification_worker USING (true);
CREATE POLICY notification_worker_jobs_insert
  ON public.notifications FOR INSERT TO notification_worker WITH CHECK (true);
CREATE POLICY notification_worker_jobs_update
  ON public.notifications FOR UPDATE TO notification_worker
  USING (true) WITH CHECK (true);
CREATE POLICY notification_worker_deliveries_all
  ON public.notification_deliveries FOR ALL TO notification_worker
  USING (true) WITH CHECK (true);
ALTER TABLE public.notification_worker_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_worker_runs_all
  ON public.notification_worker_runs FOR ALL TO notification_worker
  USING (true) WITH CHECK (true);

-- Cache writes belong to a separate, restricted catalog refresh role.
DO $catalog_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'problems', 'curriculum_problems', 'codeforces_contests',
    'contest_problem_metadata', 'codeforces_submissions',
    'codeforces_rating_history', 'codeforces_profile_cache'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      table_name || '_authenticated_read', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO catalog_worker
       USING (true) WITH CHECK (true)',
      table_name || '_catalog_worker_all', table_name
    );
  END LOOP;
END
$catalog_policies$;
ALTER TABLE public.codeforces_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY codeforces_sync_state_catalog_worker_all
  ON public.codeforces_sync_state FOR ALL TO catalog_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.user_profiles, public.training_profiles, public.user_preferences,
  public.daily_sets, public.daily_problems, public.journal_entries,
  public.virtual_contest_sessions, public.virtual_contest_problem_events,
  public.learner_profile_state, public.problem_learning_events,
  public.solve_sessions, public.review_queue, public.review_events,
  public.weekly_goals, public.contest_participation,
  public.contest_problem_reviews, public.notification_preferences,
  public.push_subscriptions
TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.training_groups, public.training_group_memberships,
  public.training_assignments
TO authenticated;
GRANT SELECT, INSERT ON TABLE public.coach_student_relationships TO authenticated;
GRANT SELECT, INSERT ON TABLE public.assignment_progress TO authenticated;
REVOKE UPDATE ON TABLE public.assignment_progress FROM authenticated;
GRANT UPDATE (status, response, student_notes, started_at, submitted_at, updated_at)
  ON TABLE public.assignment_progress TO authenticated;
GRANT SELECT ON TABLE
  public.problems, public.curriculum_problems, public.codeforces_contests,
  public.contest_problem_metadata, public.codeforces_submissions,
  public.codeforces_rating_history, public.codeforces_profile_cache,
  public.notifications, public.notification_deliveries
TO authenticated;
GRANT SELECT (
  training_profile_id, contest_reminders, daily_reminders, reminder_time, timezone
) ON TABLE public.notification_preferences TO notification_worker;
GRANT SELECT (
  endpoint_hash, training_profile_id, endpoint, p256dh, auth_secret, active
) ON TABLE public.push_subscriptions TO notification_worker;
GRANT SELECT (
  id, training_profile_id, event_key, kind, payload, scheduled_at, status,
  attempts, next_attempt_at, lease_owner, lease_expires_at, created_at, sent_at
) ON TABLE public.notifications TO notification_worker;
GRANT INSERT (
  user_id, training_profile_id, event_key, kind, payload, scheduled_at, status,
  attempts, next_attempt_at, lease_owner, lease_expires_at
) ON TABLE public.notifications TO notification_worker;
GRANT UPDATE (
  status, attempts, next_attempt_at, lease_owner, lease_expires_at, sent_at
) ON TABLE public.notifications TO notification_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.notification_deliveries, public.notification_worker_runs
TO notification_worker;
GRANT SELECT ON TABLE
  public.problems, public.curriculum_problems, public.codeforces_contests,
  public.contest_problem_metadata, public.codeforces_submissions,
  public.codeforces_rating_history, public.codeforces_profile_cache,
  public.codeforces_sync_state
TO catalog_worker;

DO $anon_revoke$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'user_profiles', 'training_profiles', 'user_preferences',
    'daily_sets', 'daily_problems', 'journal_entries',
    'virtual_contest_sessions', 'virtual_contest_problem_events',
    'learner_profile_state', 'problem_learning_events', 'solve_sessions',
    'review_queue', 'review_events', 'weekly_goals', 'contest_participation',
    'contest_problem_reviews', 'coach_student_relationships',
    'training_groups', 'training_group_memberships', 'training_assignments',
    'assignment_progress', 'social_profiles', 'codeforces_link_challenges',
    'codeforces_credentials', 'codeforces_friends_cache', 'friend_requests',
    'friendships', 'friend_presence', 'friend_activity_preferences',
    'blog_watchlist', 'blog_entries', 'blog_entry_comments', 'blog_entry_state',
    'social_sync_state', 'social_notifications',
    'problems', 'curriculum_problems',
    'codeforces_contests', 'contest_problem_metadata',
    'codeforces_submissions', 'codeforces_rating_history',
    'codeforces_profile_cache', 'codeforces_sync_state',
    'notification_preferences', 'push_subscriptions', 'notifications',
    'notification_deliveries', 'notification_worker_runs'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', table_name);
  END LOOP;
END
$anon_revoke$;

REVOKE ALL ON TABLE
  public.codeforces_link_challenges, public.codeforces_credentials
FROM anon, authenticated;
REVOKE ALL ON TABLE
  public.notification_worker_runs
FROM anon, authenticated;
REVOKE ALL ON TABLE
  public.notifications, public.notification_deliveries, public.codeforces_sync_state
FROM anon, authenticated;
GRANT SELECT ON TABLE
  public.notifications, public.notification_deliveries
TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.problems, public.curriculum_problems, public.codeforces_contests,
  public.contest_problem_metadata, public.codeforces_submissions,
  public.codeforces_rating_history, public.codeforces_profile_cache
FROM anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE
  public.problems, public.curriculum_problems, public.codeforces_contests,
  public.contest_problem_metadata, public.codeforces_submissions,
  public.codeforces_rating_history, public.codeforces_profile_cache,
  public.codeforces_sync_state
TO catalog_worker;
```

The final reviewed migration must revoke `anon` access only on these explicitly enumerated application tables (not blanket-revoke unrelated `public` schema objects), grant authenticated CRUD only on user-owned tables governed by owner policies, `SELECT` only on shared catalog tables, and no direct user writes to notification queue/delivery state. Do not grant worker cross-user policies or shared-cache writes to `authenticated`.

Row ownership does not prove a field's provenance. Authenticated users must not be able to set trusted verification flags such as `daily_problems.verified_cf_ac` or `problem_learning_events.verified_ac`, or social Codeforces verification timestamps. Set these only through verified server/RPC paths with column-level grants or triggers; migration imports may preserve them only after evidence validation and audit logging.

The following policies are the intended coaching boundary. The insert policy requires a pending invitation created by one of its participants; only the narrow accept/revoke RPC may change relationship status. Group student membership is created by a coach/student invitation RPC, not by arbitrary client insert.

```sql
ALTER TABLE public.coach_student_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY coach_student_read_participant
  ON public.coach_student_relationships FOR SELECT TO authenticated
  USING (coach_user_id = (SELECT auth.uid()) OR student_user_id = (SELECT auth.uid()));
CREATE POLICY coach_student_create_pending
  ON public.coach_student_relationships FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = (SELECT auth.uid())
    AND (coach_user_id = (SELECT auth.uid()) OR student_user_id = (SELECT auth.uid()))
    AND status = 'PENDING'
  );

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_private TO authenticated;
CREATE FUNCTION app_private.is_current_group_member(
  p_group_id uuid,
  p_member_role text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.training_group_memberships m
    WHERE m.group_id = p_group_id
      AND m.user_id = (SELECT auth.uid())
      AND (p_member_role IS NULL OR m.member_role = p_member_role)
  );
$$;
REVOKE ALL ON FUNCTION app_private.is_current_group_member(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.is_current_group_member(uuid, text) TO authenticated;

ALTER TABLE public.training_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_groups_read_member
  ON public.training_groups FOR SELECT TO authenticated
  USING (
    coach_user_id = (SELECT auth.uid())
    OR app_private.is_current_group_member(id, NULL)
  );
CREATE POLICY training_groups_create_coach
  ON public.training_groups FOR INSERT TO authenticated
  WITH CHECK (coach_user_id = (SELECT auth.uid()));
CREATE POLICY training_groups_update_coach
  ON public.training_groups FOR UPDATE TO authenticated
  USING (coach_user_id = (SELECT auth.uid()))
  WITH CHECK (coach_user_id = (SELECT auth.uid()));
CREATE POLICY training_groups_delete_coach
  ON public.training_groups FOR DELETE TO authenticated
  USING (coach_user_id = (SELECT auth.uid()));

ALTER TABLE public.training_group_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY group_memberships_read_self_or_coach
  ON public.training_group_memberships FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.training_groups g
      WHERE g.id = group_id AND g.coach_user_id = (SELECT auth.uid())
    )
  );
CREATE POLICY group_memberships_create_coach
  ON public.training_group_memberships FOR INSERT TO authenticated
  WITH CHECK (
    member_role = 'COACH' AND user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.training_groups g
      WHERE g.id = group_id AND g.coach_user_id = (SELECT auth.uid())
    )
  );
CREATE POLICY group_memberships_remove_self_or_coach
  ON public.training_group_memberships FOR DELETE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.training_groups g
      WHERE g.id = group_id AND g.coach_user_id = (SELECT auth.uid())
    )
  );

ALTER TABLE public.training_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignments_read_participant
  ON public.training_assignments FOR SELECT TO authenticated
  USING (
    (
      (student_user_id = (SELECT auth.uid())
        AND app_private.is_current_group_member(group_id, 'STUDENT'))
      OR (coach_user_id = (SELECT auth.uid())
        AND app_private.is_current_group_member(group_id, 'COACH'))
    )
    AND EXISTS (
      SELECT 1 FROM public.coach_student_relationships r
      WHERE r.coach_user_id = training_assignments.coach_user_id
        AND r.student_user_id = training_assignments.student_user_id
        AND r.status = 'ACCEPTED'
    )
  );
CREATE POLICY assignments_create_coach
  ON public.training_assignments FOR INSERT TO authenticated
  WITH CHECK (
    coach_user_id = (SELECT auth.uid())
    AND app_private.is_current_group_member(group_id, 'COACH')
    AND EXISTS (
      SELECT 1 FROM public.coach_student_relationships r
      WHERE r.coach_user_id = training_assignments.coach_user_id
        AND r.student_user_id = training_assignments.student_user_id
        AND r.status = 'ACCEPTED'
    )
    AND EXISTS (
      SELECT 1 FROM public.training_group_memberships m
      WHERE m.group_id = training_assignments.group_id
        AND m.user_id = training_assignments.student_user_id
        AND m.member_role = 'STUDENT'
    )
  );
CREATE POLICY assignments_update_coach
  ON public.training_assignments FOR UPDATE TO authenticated
  USING (
    coach_user_id = (SELECT auth.uid())
    AND app_private.is_current_group_member(group_id, 'COACH')
  )
  WITH CHECK (
    coach_user_id = (SELECT auth.uid())
    AND app_private.is_current_group_member(group_id, 'COACH')
    AND EXISTS (
      SELECT 1 FROM public.coach_student_relationships r
      WHERE r.coach_user_id = training_assignments.coach_user_id
        AND r.student_user_id = training_assignments.student_user_id
        AND r.status = 'ACCEPTED'
    )
  );
CREATE POLICY assignments_delete_coach
  ON public.training_assignments FOR DELETE TO authenticated
  USING (
    coach_user_id = (SELECT auth.uid())
    AND app_private.is_current_group_member(group_id, 'COACH')
  );

ALTER TABLE public.assignment_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignment_progress_read_participant
  ON public.assignment_progress FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.training_assignments a
      JOIN public.coach_student_relationships r
        ON r.coach_user_id = a.coach_user_id
       AND r.student_user_id = a.student_user_id
      WHERE a.id = assignment_id
        AND r.status = 'ACCEPTED'
        AND (
          (a.student_user_id = (SELECT auth.uid())
            AND app_private.is_current_group_member(a.group_id, 'STUDENT'))
          OR (a.coach_user_id = (SELECT auth.uid())
            AND app_private.is_current_group_member(a.group_id, 'COACH'))
        )
    )
  );
CREATE POLICY assignment_progress_student_insert
  ON public.assignment_progress FOR INSERT TO authenticated
  WITH CHECK (
    student_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.training_assignments a
      JOIN public.coach_student_relationships r
        ON r.coach_user_id = a.coach_user_id
       AND r.student_user_id = a.student_user_id
      WHERE a.id = assignment_id
        AND a.student_user_id = (SELECT auth.uid())
        AND r.status = 'ACCEPTED'
    )
  );
CREATE POLICY assignment_progress_student_update
  ON public.assignment_progress FOR UPDATE TO authenticated
  USING (
    student_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.training_assignments a
      JOIN public.coach_student_relationships r
        ON r.coach_user_id = a.coach_user_id
       AND r.student_user_id = a.student_user_id
      WHERE a.id = assignment_id
        AND a.student_user_id = (SELECT auth.uid())
        AND r.status = 'ACCEPTED'
    )
  )
  WITH CHECK (
    student_user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.training_assignments a
      JOIN public.coach_student_relationships r
        ON r.coach_user_id = a.coach_user_id
       AND r.student_user_id = a.student_user_id
      WHERE a.id = assignment_id
        AND a.student_user_id = (SELECT auth.uid())
        AND r.status = 'ACCEPTED'
    )
  );
```

The `app_private.is_current_group_member(group_id, role)` helper referenced above must be a narrowly scoped `SECURITY DEFINER` SQL function with `SET search_path=''`, whose only query checks the caller's `auth.uid()` against `training_group_memberships`; revoke execute from `PUBLIC` and grant only to `authenticated`. This prevents a recursive RLS policy cycle between groups and memberships and does not rely on a caller-set GUC. In addition, revoke table-level `UPDATE` on `assignment_progress` from `authenticated` and grant only student-editable columns; coach feedback/review timestamps are written through a checked coach RPC. Group creation must add the owner as a `COACH` membership atomically, and membership role changes must not be directly client writable.

For social tables, enable RLS on all 14 tables; use self-only `ALL` policies for the owner tables; participant-only read/delete for friend requests; sender-only inserts; recipient-only state changes through a checked state-transition trigger/RPC; friendship insertion only after an accepted request and participant identity check; friend presence only for actual friends and subject to `show_cp_presence`; and friend profile reads through an allow-listed RPC returning only opt-in non-secret columns. Keep `social_profiles` base-table SELECT self-only. Credentials are server-only. Remove the `app.cp_coach_backend` condition from every policy. Table grants alone do not grant access through RLS.

```sql
-- Existing are_social_friends_with(uuid) is retained only after reviewing its
-- fixed search_path, auth.uid() behavior, ownership, and EXECUTE grants.
DO $social_owner_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'codeforces_link_challenges', 'codeforces_credentials',
    'codeforces_friends_cache', 'blog_watchlist', 'blog_entries',
    'blog_entry_comments', 'blog_entry_state', 'social_sync_state',
    'social_notifications'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
       USING (user_id = (SELECT auth.uid()))
       WITH CHECK (user_id = (SELECT auth.uid()))',
      table_name || '_owner_all', table_name
    );
  END LOOP;
END
$social_owner_policies$;

ALTER TABLE public.social_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY social_profiles_read_self
  ON public.social_profiles FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY social_profiles_insert_self
  ON public.social_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND codeforces_handle IS NULL);
CREATE POLICY social_profiles_update_self
  ON public.social_profiles FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE FUNCTION app_private.is_friend_presence_visible(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.social_profiles p
    WHERE p.user_id = p_user_id
      AND p.show_cp_presence
      AND public.are_social_friends_with(p_user_id)
  );
$$;
REVOKE ALL ON FUNCTION app_private.is_friend_presence_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.is_friend_presence_visible(uuid) TO authenticated;

CREATE FUNCTION app_private.get_visible_social_profile(p_other_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  codeforces_handle text,
  show_cp_presence boolean,
  show_last_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.user_id,
    p.codeforces_handle,
    CASE WHEN p.user_id = (SELECT auth.uid())
           OR public.are_social_friends_with(p.user_id)
         THEN p.show_cp_presence ELSE false END,
    CASE WHEN p.user_id = (SELECT auth.uid())
           OR public.are_social_friends_with(p.user_id)
         THEN p.show_last_active ELSE false END
  FROM public.social_profiles p
  WHERE p.user_id = p_other_user_id
    AND (
      p.user_id = (SELECT auth.uid())
      OR public.are_social_friends_with(p.user_id)
      OR (p.allow_friend_requests AND p.codeforces_handle IS NOT NULL)
    );
$$;
REVOKE ALL ON FUNCTION app_private.get_visible_social_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.get_visible_social_profile(uuid) TO authenticated;

ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY friend_requests_read_participant
  ON public.friend_requests FOR SELECT TO authenticated
  USING (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()));
CREATE POLICY friend_requests_create_sender
  ON public.friend_requests FOR INSERT TO authenticated
  WITH CHECK (sender_id = (SELECT auth.uid()) AND status = 'pending');
CREATE POLICY friend_requests_update_recipient
  ON public.friend_requests FOR UPDATE TO authenticated
  USING (recipient_id = (SELECT auth.uid()))
  WITH CHECK (recipient_id = (SELECT auth.uid()));
CREATE POLICY friend_requests_delete_participant
  ON public.friend_requests FOR DELETE TO authenticated
  USING (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()));

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
CREATE POLICY friendships_read_participant
  ON public.friendships FOR SELECT TO authenticated
  USING (user_low_id = (SELECT auth.uid()) OR user_high_id = (SELECT auth.uid()));
CREATE POLICY friendships_accept_request
  ON public.friendships FOR INSERT TO authenticated
  WITH CHECK (
    (user_low_id = (SELECT auth.uid()) OR user_high_id = (SELECT auth.uid()))
    AND EXISTS (
      SELECT 1 FROM public.friend_requests r
      WHERE r.status = 'accepted'
        AND ((r.sender_id = user_low_id AND r.recipient_id = user_high_id)
          OR (r.sender_id = user_high_id AND r.recipient_id = user_low_id))
    )
  );
CREATE POLICY friendships_delete_participant
  ON public.friendships FOR DELETE TO authenticated
  USING (user_low_id = (SELECT auth.uid()) OR user_high_id = (SELECT auth.uid()));

ALTER TABLE public.friend_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY friend_presence_read_opted_in_friends
  ON public.friend_presence FOR SELECT TO authenticated
  USING (app_private.is_friend_presence_visible(user_id));
CREATE POLICY friend_presence_manage_self
  ON public.friend_presence FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

ALTER TABLE public.friend_activity_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY friend_activity_preferences_manage_friend
  ON public.friend_activity_preferences FOR ALL TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.are_social_friends_with(friend_id)
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.are_social_friends_with(friend_id)
  );

-- Handles/verification timestamps are changed only by the verified link RPC.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.social_profiles FROM authenticated;
GRANT SELECT ON TABLE public.social_profiles TO authenticated;
GRANT UPDATE (
  allow_friend_requests, show_cp_presence, show_last_active,
  notify_friend_requests, notify_new_posts, updated_at
) ON TABLE public.social_profiles TO authenticated;
REVOKE ALL ON TABLE
  public.codeforces_link_challenges, public.codeforces_credentials
FROM authenticated;
```

The profile/presence helper functions are `SECURITY DEFINER` only to read a private social row behind an allow-listed result. Keep their owner controlled, schema/function grants minimal, `search_path` fixed, and `auth.uid()` sourced from the verified JWT. They expose no credentials or private notes; do not restore a friend-readable base-table policy.

Provision `notification_worker` and (if cache refresh is separated) `catalog_worker` as dedicated `NOBYPASSRLS`, non-owner roles outside the user API credential. Enable RLS on worker tables and grant only the narrow worker policies/columns they need; do not make a worker a table owner. The notification role needs SELECT on due preferences and active subscription fields, INSERT/UPDATE on notification job/delivery rows, and INSERT/UPDATE on run history. The catalog role needs only refresh rights on shared catalog/cache tables. Avoid storing either credential in frontend configuration.

Shared Codeforces catalog/cache tables use RLS with `SELECT` to `authenticated` only; no authenticated insert/update/delete. Background refresh is through the dedicated worker role, not the user-facing service-role key. `user_id` cannot be changed by normal update: use column privileges or an `UPDATE` trigger to reject ownership changes. Add a table and policy inventory test so new tables cannot ship without RLS.

**Worker role:** provision a separate database role with `NOBYPASSRLS`, no table ownership, no superuser, no Auth administration, and grants only on Codeforces cache tables and the notification tables/columns it needs. It may read active notification subscriptions across owners only because delivery requires that capability; keep this credential confined to the background worker and audit it. If grants require a `SECURITY DEFINER` function, use a fixed `search_path`, revoke execute from `PUBLIC`, grant only to the worker role, and keep the function body narrowly scoped. The worker's access is not available to ordinary API requests.

**Migrations/admin:** schema migrations use an operator-controlled migration credential only in a reviewed maintenance action; it is never configured in Railway's user request path. Revoke `anon` privileges on private tables. The normal Node API forwards the user's verified JWT to PostgREST. Do not use service-role credentials to bypass RLS for normal user requests. The existing direct-pool `withSystemTransaction` and `withUserTransaction` paths require redesign/role review before becoming production paths.

## 7. API authorization audit

### 7.1 Existing training APIs

The private router in `backend/src/routes.ts` is mounted at `/api` when not in public mode and at `/api/admin` in public mode. `requireApiToken` permits all requests when `COACH_API_TOKEN` is unset; when set, one shared bearer token protects the whole API. In public deployment, admin routes use `requireConfiguredToken`, but normal user-data routes are served by the public router instead. A shared application token is not per-user tenancy.

| Route family (methods/routes in `routes.ts`) | Current storage and authorization finding |
|---|---|
| Profiles: `GET/POST /profiles`, `POST /profiles/:id/select`, `DELETE /profiles/:id` | Reads/writes global SQLite profiles and a global active profile; no per-user authorization. |
| Dashboard/daily: `GET /dashboard`, `GET /daily`, `POST /problems/:id/open`, `POST /problems/:id/feedback`, `POST /daily/replace` | Data is selected using active/query profile ID. No authenticated owner check in private router. |
| Learning: `GET /learner`, `GET /history`, `GET /journal`, `GET/POST /context` | Per-profile or profile-derived state; private API has no tenant owner check. Context import can replace/merge scoped data but relies on caller-chosen profile. |
| Curriculum/tutorial: `GET /curriculum`, `GET /tutorial/:problemId`, `GET /contests/:contestId/problems/:problemIndex/tutorial`, `GET /skill-tracks` | Mostly shared/read-only content; still must not allow cross-user data through joins or profile parameters. |
| Sync/network/status: `POST /sync`, `GET /network-info`, `GET /sync/status` | Updates shared cache/sync state; lease owner is operational, not authenticated user. |
| Contest data: `GET /contests`, `POST /contests/sync`, `GET /contests/upcoming`, `POST /contests/import`, `GET /contests/:contestId`, `POST /contests/:contestId/review`, `POST /contests/:contestId/problems/:problemIndex/send-to-review` | Read/write user contests and contest reviews by profile ID; private routes do not establish ownership. |
| Reports/goals/plans: `GET /weekly-report`, `GET/POST /weekly-goals`, `GET /training-plan` | Profile-scoped records, but no user-to-profile authorization in the private router. |
| Reviews: `GET /reviews`, `POST /reviews/enqueue`, `POST /reviews/:problemId/action` | Per-profile queue. No tenant ownership check in private router. |
| Sessions: `POST /sessions/start`, `POST /sessions/:id/hint`, `POST /sessions/:id/editorial`, `POST /sessions/:id/finish`, `GET /sessions/analytics` | Uses profile/session IDs; no user ownership check in private router. |
| Notifications: `GET /notifications/config`, `GET /notifications/subscriptions/status`, `GET/PUT /notifications/settings`, `POST/DELETE /notifications/subscriptions` | SQLite or D1 depending on configuration/fallback; profile and client data, not canonical Auth identity. Shared subscription keys are sensitive. |
| Health: `GET /health` | Liveness/database availability only; no user data authorization concern. |

**Result:** no legacy private training endpoint is ready for authenticated multi-user exposure. Route-by-route release requires extracting `user_id` from the verified JWT, rejecting client-supplied owner IDs, constraining every query/mutation with both `user_id` and profile ID, and relying on RLS as a second boundary.

### 7.2 Public and social routes

`/api/public` profile-list/create endpoints key profiles via `X-Coach-Client-Id` and may accept a handle; downstream profile-scoped middleware requires a syntactically valid client ID and handle, resolves/creates a profile, and overwrites submitted `profileId` in body/query. That reduces accidental cross-profile writes but the client ID is browser-held, unauthenticated bearer-like state and can be copied/lost. Handle validation confirms a public Codeforces handle exists; it does not authenticate the user or establish history ownership.

Explicit ownership middleware exists for:

- `POST /problems/:id/open` and `/problems/:id/feedback`
- `POST /daily/replace` (checks the submitted daily-problem identifier)
- `POST /reviews/:problemId/action`
- `POST /sessions/:id/hint`, `/editorial`, and `/finish`

Other operations use profile-resolution middleware rather than an authenticated user: profile list/create/select/delete; context export/import; notification preferences and subscriptions; sync/contest sync/import. Review ownership checks require the matching profile/problem row. Each endpoint still needs a transaction-level owner predicate and must not accept client identifiers as identity in the final design. Validate all relationship IDs in one transaction to avoid TOCTOU gaps. Notifications forward D1 operations using the client owner string. D1's shared secret authenticates the backend service, not the end user.

`/api/social` verifies Supabase bearer tokens in the social auth middleware, but the current direct `pg` transaction sets `request.jwt.claims` and the `app.cp_coach_backend` custom GUC itself. This is not equivalent to PostgREST verifying the signed JWT at the database boundary. Replace it with caller-JWT forwarding or a reviewed alternative that cryptographically authenticates claims at the DB boundary and uses least-privilege roles.

## 8. Notification migration design

1. Use PostgreSQL as the only durable notification source. The scheduled Railway worker queries the canonical preferences/subscriptions and generates notification events from migrated assignments and the shared contest schedule. Do not store a second durable copy in D1.
2. Keep VAPID public/private keys in Railway secret configuration, not PostgreSQL or frontend code. Before cutover, inventory the active Cloudflare VAPID pair without printing it, transfer the exact keypair through an approved secret-management path, and retain the same public key for existing browser subscriptions; do not rotate during migration. Keep the Web Push endpoint, `p256dh`, and `auth` subscription fields private and accessible only to the owner and notification worker.
3. Preserve D1 notification profile settings and timezone, subscriptions and active status, endpoint hashes, delivery status/attempt/sent/retry times, and bounded run history. Migrate SQLite notification rows too, even though the current local tables are empty. Compare endpoint hashes and owner/profile mappings before choosing a canonical row.
4. Build daily notification content from PostgreSQL `daily_sets`/`daily_problems`; D1's `daily_snapshot` is a cache and must be compared, not treated as authoritative. Keep contest metadata rebuildable from Codeforces.
5. Use deterministic event keys, e.g. `contest:<contest_id>:<reminder-offset>` and `daily:<local-date>:<daily-set-id>`. Store a unique `(training_profile_id,event_key)` event and unique `(training_profile_id,endpoint_hash,notification_key)` delivery. Claim due rows transactionally with `FOR UPDATE SKIP LOCKED` plus a lease token/expiry. Backoff retries with a bounded attempt count; deactivate invalid endpoints on permanent Web Push responses. Store error codes, not secrets or full endpoint URLs, in logs.
6. A database ledger prevents most duplicate sends, but Web Push cannot provide exactly-once delivery: a worker crash after provider acceptance and before recording `SENT` can still cause a duplicate. Document this at-least-once edge and make notification payloads idempotent on the client where possible.
7. Cutover protocol: pause the D1 scheduled trigger and all SQLite/Cloudflare senders; take and verify snapshots; import preferences, subscriptions, and ledgers in one idempotent batch; reconcile duplicate endpoint/event keys with `SENT` taking precedence over retryable states; suppress already-sent keys; run a dry-run that emits no push; then enable only the PostgreSQL worker. Do not dual-send. Retain D1 in read-only/quarantined state for an agreed rollback window; if rollback is approved, stop the new worker before re-enabling the old sender and import any newly sent keys back first.
8. Use a Postgres advisory lock or short-lived lease for single scheduler coordination. Record run IDs, counts, duration, and safe error codes. Never copy a live D1 lock as valid.

## 9. WAL-safe SQLite backup, restore, and verification

### Tool and test

Added [backup-sqlite-safe.py](../scripts/backup-sqlite-safe.py). It opens the source with SQLite `mode=ro` and `query_only`, uses `Connection.backup()` (which snapshots committed WAL content), creates a unique output in the requested destination, refuses replacement, does not prune, and verifies `integrity_check`, `foreign_key_check`, schema digest, table counts, and a SHA-256 checksum. Its no-overwrite publication uses an atomic same-filesystem hard link; if the destination filesystem does not support hard links, it fails rather than falling back to replacement. It does not write into the source database. Keep backup directories access-controlled and encrypt copies at rest; this tool does not encrypt them.

The existing `scripts/backup-db.js` is not suitable for a live WAL database: it copies the main file and prunes older backups. Do not use it as the migration recovery procedure.

Tested on a newly created disposable temporary database with WAL autocheckpoint disabled and two committed rows present only in the WAL. The generated backup contained both rows, passed integrity and FK checks, and the source main database and WAL file hashes were unchanged. The test did not read or write any project database. This validates the WAL snapshot mechanism, not recovery of the production database or its application semantics.

Example (run only after separate authorization and destination review):

```powershell
python scripts\backup-sqlite-safe.py `
  --source backend\data\cp_coach.db `
  --backup-dir D:\cp-coach-recovery
```

The backup path is unique and must be copied to encrypted, access-controlled storage by a separate approved process. Preserve the JSON output (path, byte count, table counts, schema/file SHA-256) alongside the backup; do not put credentials or row contents in the manifest.

### Restore rehearsal and recovery steps

1. Before migration, create an online backup from every actual SQLite source while the application is healthy. Record output/hash and preserve source `-wal`/`-shm` operational context until backup completion; do not copy only the main file while the DB is live.
2. Restore the backup to a **new, empty path**, never over the source. Open the copy, run `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, list schema/table counts, and run application read-only smoke tests against the copy.
3. Compare restored schema digest and table counts with the manifest; separately compare required user-owned aggregates and sampled row hashes using a reviewed, privacy-safe verifier. Investigate every mismatch.
4. For a future approved rollback, stop all writers first and snapshot the PostgreSQL target. If no target-side user writes occurred, the old source can be reopened only after the staging restore passes. If writes occurred after cutover, do not point users at a stale SQLite/D1 snapshot: reconcile and replay the post-cutover PostgreSQL delta through an audited reverse importer, or keep PostgreSQL primary and roll forward. Reconcile notification delivery keys before any old sender is re-enabled. Only perform an explicitly approved service cutover. Retain the original source and failed target as immutable recovery evidence until acceptance. Do not overwrite or delete either during the rollback rehearsal.
5. Run a periodic restore rehearsal and record date, input checksum, output checksum, test results, and operator. A successful backup command alone is not proof of recoverability.

## 10. Migration phases and validation gates

1. **Inventory/approval:** identify actual production SQLite path, D1 database/version and row counts, Supabase project/Auth IDs and migration history, browser export status, user count, region, and backup retention. Obtain data-owner and operational approval.
2. **Freeze schema and identity map:** approve field mappings, target DDL, claim policy, timezone semantics, retention, duplicate handling, and exact exclusions. Create a restricted source-profile→Auth-user→target-profile crosswalk. Never match on handle.
3. **Backups and rehearsal:** run the SQLite tool above for each source and verify restore; export D1 with supported tooling; take a reviewed PostgreSQL schema/data backup and record migration history; obtain browser exports from data owners. Encrypt and access-control recovery copies.
4. **Build target in non-production:** apply reviewed migrations only to a separately approved staging project; test RLS with at least two unrelated users, unauthenticated access, malformed/expired JWTs, forged `user_id`, cross-profile FKs, coach/student revocation, and worker-role permissions.
5. **Dry-run importer:** load into staging, report per-table/source-owner counts, orphan/duplicate/collision reports, JSON parsing, time-zone/date checks, verified-AC evidence, subscription collisions, and stable hashes. Run importer twice and after interrupted batches; prove idempotency and resumability.
6. **Application parity:** migrate APIs from SQLite to PostgreSQL using verified user JWTs; add route authorization tests for every training write/read. Test exports/imports, daily generation, journal, review scheduling, goals, contest results, social, coaching, and notifications. No SQLite fallback in production after the declared cutover.
7. **Cutover rehearsal:** pause writes/senders, take final snapshots, import delta once, run integrity/RLS/business checks, enable PostgreSQL worker once, monitor. Declare stop/rollback criteria and cutover owner.
8. **Production migration:** requires a separate explicit approval naming the project, database, date/window, exact source paths, target migration revision, user mapping, backup location, budget, operator, rollback trigger, and data-retention/deletion schedule. Do not delete the old source as part of the migration task.
9. **Decommission:** only after user acceptance, backup retention expiry, and separate approval; remove old SQLite/D1 dependencies in a later controlled change. No automatic deletion.

### Duplicate detection and data-validation gates

- Report collisions before writes for `(user_id,lower(codeforces_handle))`, `(training_profile_id,local_date)`, `(daily_set_id,problem_id)`, `(training_profile_id,source_key)`, `(training_profile_id,problem_id)` in the current review queue, `(training_profile_id,week_start_date)`, `(training_profile_id,contest_id)`, `(training_profile_id,contest_id,problem_index)`, `(training_profile_id,event_key)`, and `(training_profile_id,endpoint_hash,notification_key)`.
- Compare profile IDs/owner IDs through the explicit mapping ledger. Identical Codeforces handles across owners are not duplicates to merge; preserve them as separate candidate histories until each owner approves a merge.
- Validate UUID remaps, every FK/orphan, required/non-null fields, statuses, integer-to-boolean conversion, JSON/text-array parsing, timestamps and time zones, daily-set dates, unique profile defaults, submission links, notification endpoint collisions, and presence of every source table/field in the import report.
- Treat the 997 verified learning events as asserted source evidence. Compare their `verified_ac` values and event source against linked submission evidence where available; quarantine unexplained conflicts. Do not equate `self_reported_solved` or `completed` with verified acceptance.
- Preserve `source_key`, browser note IDs, virtual contest keys, old SQLite text IDs, D1 delivery IDs, and source checksums in a restricted crosswalk until target row counts and stable hashes pass. Record exclusions and transformations; never silently drop unknown settings or JSON keys.

### Required test matrix

- DDL applies cleanly to an isolated Supabase staging project; migration is repeatable or has explicit forward/rollback revisions.
- RLS integration tests with user A/user B, an unauthenticated client, and a restricted worker role. Test SELECT/INSERT/UPDATE/DELETE and foreign-key cross-owner attempts for every table.
- Account claim tests: correct, wrong, expired, replayed, revoked browser token; multiple same-handle profiles; null-owner local profile; colliding export; no claim based on handle.
- Import tests: all SQLite fields, nullable/default values, unique collisions, duplicate event source keys, malformed JSON, orphan FKs, time zones/day boundaries, zero-row and large-row tables, retry/resume.
- API authorization tests for all existing training endpoints and all child-object ID routes; forged profile/user IDs must return no data and cause no writes.
- Notification tests: schedule boundaries/time zones, stable dedupe keys, claim race with parallel workers, retries/backoff, invalid subscriptions, crash after send, D1/SQLite duplicate ledgers, disabled preferences, and one-sender-only cutover.
- Recovery tests: restore every source backup into a clean path; integrity/FK checks; compare schema, counts and key user aggregates; exercise the documented rollback on staging.
- Load/operational tests at approximately 20 concurrent users, database connection-pool limits, worker/API contention, alerting, backup retention, and Railway restart behavior.

## 11. Hosting recommendation and estimated cost

| Component | Recommendation for ~20 users | Reliability / limits |
|---|---|---|
| Database/Auth | One Supabase PostgreSQL project on a paid production plan, same region as Railway where practical. Auth is canonical. | Current pricing lists Pro from $25/month with one Micro compute covered by included compute credit and 8 GB disk; included automatic backups are 7 days. Free tier is not recommended as the production durability baseline. Confirm region, quotas, backup retention, and current terms before provisioning. |
| API + notification worker | Two stateless Railway services (Node API and one background worker), with PostgreSQL as their only durable application store. Keep local filesystem/cache disposable; never persist user data there. Start with small resources and alerts/usage caps. | Railway Hobby is $5/month and includes $5 monthly usage; Pro is $20/month and includes $20 usage. Resource usage is metered beyond included credit. For a production user-facing service, budget the Pro base unless the owner explicitly accepts Hobby limits. Railway restarts must not lose application records. |
| Frontend | Cloudflare Pages static hosting. | Static assets are edge-served; no durable user data or secrets in Pages/local browser storage. Free static hosting can be $0 at this scale within current plan limits. |
| Notification schedule | Dedicated Railway worker using PostgreSQL; no D1 persistence. | Worker can restart safely via database leases/idempotency. Alert on missed runs, queue age, failures and duplicate keys. |

**Planning estimate:** approximately **$45/month baseline** (Supabase Pro $25 + Railway Pro $20, assuming usage remains within included credits; Cloudflare Pages $0), before overages, taxes, optional PITR, encrypted external backups, domains, email delivery, or monitoring. Railway services may exceed included usage, so an initial practical operating range is **$45–$75/month** until measured. Supabase PITR is listed as an additional $100/month per 7 days of retention; do not enable it without explicit budget approval. A cheaper Supabase free + Railway Hobby test environment is not the final durable production recommendation.

Pricing sources checked on 2026-11-03: [Supabase pricing](https://supabase.com/pricing), [Railway pricing](https://railway.com/pricing), [Cloudflare Pages](https://pages.cloudflare.com/). Prices, quotas, available regions, backup terms, and service limits can change; confirm them before any paid resource is created. Select the nearest mutually available database/API region after checking latency and data residency requirements.

## 12. Risks, unresolved decisions, and approvals

### Remaining risks / decisions

- Which authenticated users, if any, are authorized to claim each of the two null-owner local profiles?
- Is there a live Supabase project, and is its Auth UUID namespace the one that must remain canonical?
- Is there deployed D1 state or a scheduled worker? What are its schema version, row counts, and VAPID secret provenance?
- Which original browsers/backups still contain personal journal, virtual contest, or unsynced context data?
- Does any existing production service still write SQLite, D1, or both? Current repository configuration does not prove deployment behavior.
- Which local `settings` keys are user preferences versus operational configuration?
- Are all Codeforces submissions and cached rows still needed? Define retention/privacy policy for `raw_json`, blog article text, and encrypted credentials.
- Agree whether target table/API name remains `user_contests` or changes to `contest_participation`; this proposal uses the latter in DDL.
- Confirm timezone semantics. D1 currently hard-codes `Asia/Hebron`; target should store a user-selected IANA timezone and preserve source local dates.
- Confirm relationship acceptance rules, group-role model, notification retention, backup retention, region/data-residency constraints, and operating budget.
- The new group/assignment DDL's role/status rules require reviewed triggers/RPCs before use; they must not be inferred solely from membership rows.

### Exact approvals required before infrastructure work

1. **Schema/security approval:** approve a versioned DDL/RLS review and its two-user/worker test results. This is separate from the architectural-direction approval.
2. **Identity/data approval:** approve a named, auditable owner mapping for every legacy profile and browser export. Explicitly approve quarantine for records without proof; no handle-based assignment.
3. **Backup approval:** approve exact source locations, encrypted destination, retention, restore rehearsal, and operator. Verify the WAL-safe backup/restore before any importer runs.
4. **Staging approval:** authorize the exact Supabase project, Railway services, Cloudflare Pages setup, regions, plan and monthly budget. No production settings or paid resources are authorized by this report.
5. **Migration approval:** separately authorize an exact migration revision, source and target, maintenance window, data freeze, worker cutover, rollback trigger, and post-migration validation criteria.
6. **Decommission approval:** separately authorize any SQLite/D1 deletion or credential retirement after acceptance and retention expiry. No deletion/reset is part of this plan.

## Recommendation

Proceed only with a reviewed staging implementation of the schemas, verified JWT-to-RLS path, account-claim mechanism, and restore-tested importer after the required approvals above. Do not migrate production data, apply migrations, create services, deploy, or remove SQLite/D1 based on architectural-direction approval alone. This report is the readiness deliverable; implementation and production data work remain paused for review.
