# CP Coach production data architecture

**Status:** Proposed; for review only
**Audit date:** 2026-11-03
**Scope:** Data stores, ownership, target schema/security, migration plan, hosting. No database or infrastructure changes were made for this document.

## 1. Executive recommendation

Use **one Supabase-managed PostgreSQL project as the durable source of truth** for authenticated training, journal/reviews, contests/goals, social, coaching, notification preferences, push subscriptions, and notification delivery idempotency. Use Supabase Auth for the canonical account UUID. Keep the existing Node API as the application boundary and keep frontend code free of database secrets.

Keep Codeforces reference data/cache and scheduler coordination out of the user's durable records. Prefer PostgreSQL tables with explicit expiry or Postgres advisory locks for the current 20-user scale; do not keep a second durable copy in Cloudflare D1. Cloudflare may remain an optional scheduled trigger, but the simpler initial design is the always-on backend's existing notification worker backed by PostgreSQL.

The existing SQLite database remains the local-development source only until a separately reviewed, tested migration is approved. Do not silently fall back to SQLite in production once PostgreSQL becomes authoritative. The existing Supabase social migration is **not** a production-ready full application schema or SQLite migration and must not be applied to production as-is.

No Supabase/Cloudflare databases, schemas, migrations, data, credentials, hosting settings, or services were changed or created.

## 2. Current database and persistent-storage inventory

### SQLite

`backend/src/db.ts` opens `DB_DIR/cp_coach.db`; absent `DB_DIR`, this is `backend/data/cp_coach.db`. It enables WAL. A read-only inspection found 23 tables in the backend database (about 4.8 MiB main file); the separate root `data/cp_coach.db` was a 4 KiB empty database with no application tables. The backend database had rows across local profiles, Codeforces reference/cache data, training history, and goals. Counts are a point-in-time inventory only and do not imply that this file is the only source of user data.

| SQLite table | Current purpose / ownership | Important relationships and notes |
|---|---|---|
| `profiles` | Training profiles. Local profiles have `owner_id IS NULL`; public-mode profiles use the lower-cased browser `X-Coach-Client-Id` as `owner_id`. | Parent for most learning and notification rows. Public IDs are derived from client ID + handle; neither a handle nor that ID is a Supabase identity. |
| `settings` | Global key/value app settings, including local active-profile selection. | Not user-scoped; must not remain a global active-user setting in a multi-user deployment. |
| `daily_sets` | Per-profile dated recommendation sets. | Unique `(profile_id, date)`; parent of `daily_problems`. |
| `daily_problems` | Per-profile problem assignment, opened/attempted flags, feedback, notes, self-report, and verified-AC evidence. | References `daily_sets`, `profiles`, and shared `problems`; unique per set/problem. Has evolved by startup `ALTER TABLE` steps, so source and each DB's actual columns can differ. |
| `problems` | Shared Codeforces problem catalog used for recommendations and assignments. | Key is the concatenated contest ID/index; referenced by daily assignments. |
| `curriculum_problems` | Shared curated learning objectives, topic, stage, prerequisites, and target rating. | Curriculum content, not user-owned. Seeded from code and curated data. |
| `learner_profile_state` | Per-profile serialized learner-model state (`data_json`). | One row per `profiles.id`; schema/version and contents need validation before migration. |
| `problem_learning_events` | Per-profile unified learning journal: assignment feedback, solve sessions, contest review, and verified accepted events. | Profile FK; stable `source_key` is globally unique in SQLite; source-key scope needs redesign for multi-user Postgres. |
| `review_queue` | Per-profile spaced-repetition state and notes. | Unique `(profile_id, problem_id)`; current row stores current schedule, not necessarily every historical review action. |
| `solve_sessions` | Per-profile active/completed problem attempts, hints/editorial usage, time, outcome, and reflections. | Profile FK; learning events are also backfilled from completed sessions. |
| `weekly_goals` | Per-profile weekly target counts, focus topics, notes. | Unique `(profile_id, week_start_date)`. |
| `user_contests` | Per-profile participation/results, rating change, problem counts, report JSON. | Unique `(profile_id, contest_id)`. |
| `contest_problem_reviews` | Per-profile contest problem self-review, upsolve status, and notes. | Unique `(profile_id, contest_id, problem_index)`; some imported upsolve submission IDs relate to `submissions`. |
| `contest_problems_meta` | Shared cached Codeforces contest-problem details. | Shared by contest ID/index; not user-specific. |
| `codeforces_contests` | Shared official contest metadata. | External reference/cache, not participation history. |
| `submissions` | Cached Codeforces submission records keyed by external submission ID and handle. | Indexed by handle/problem/verdict; consumed by analysis/verification. Handle-based rows can be shared cache data, but attribution in learning history must remain profile-specific. |
| `rating_history` | Cached rating changes keyed by Codeforces handle + contest. | External public account data, currently not directly linked by FK to `profiles`. |
| `profile_cache` | Cached public Codeforces user profile fields/raw JSON keyed by handle. | Shared external cache; raw profile JSON should have a retention/field-minimization policy. |
| `sync_meta` | Codeforces sync timestamps/status/error values. | Global key/value namespace; some keys encode a handle. |
| `sync_leases` | Process coordination for Codeforces sync. | Ephemeral lease state; `owner_id` here is a process/lease owner, not a user. |
| `notification_settings` | Reminder toggles/time in the local notification path. | One row per profile. |
| `push_subscriptions` | Push endpoint and key material in the local notification path. | Profile and `owner_id`; endpoint hash is primary key. Treat endpoint and subscription keys as sensitive credentials. |
| `notification_deliveries` | Push delivery state, retry time, and deduplication key in the local notification path. | Unique `(profile_id, endpoint_hash, notification_key)`. This duplicates the D1 worker's delivery ledger. |

SQLite ownership rules differ by mode. The private/local API resolves profiles with null `owner_id` and is globally protected only by optional bearer-token middleware. Public routes resolve profile ownership from a browser-stored client ID and Codeforces handle, then check profile IDs for writes. The public browser snapshot is also used to restore personal data after the ephemeral server restarts. SQLite is therefore both the local authoritative store and, in public mode, a temporary processing copy/cache.

### Supabase Auth and PostgreSQL

The checked-in `supabase/config.toml` describes a local Supabase stack, but Docker is unavailable and that stack was not started. The uncommitted `supabase/migrations/202611020001_phase1_social.sql` is the only checked-in Postgres application migration found. Its presence does **not** establish that a cloud project exists, that the migration was applied, or that its schema/RLS has been tested. There was no live database connection or credential inspection in this audit.

The migration adds 14 `public` tables:

| Table | Current intended ownership / role |
|---|---|
| `social_profiles` | One social account per Supabase `auth.users.id`; linked verified Codeforces handle and privacy/notification preferences. |
| `codeforces_link_challenges` | Per-user short-lived ownership-verification challenge hash. |
| `codeforces_credentials` | Per-user encrypted Codeforces API credential ciphertext, nonce, and authentication tag. |
| `codeforces_friends_cache` | Per-owner Codeforces friend online/rating snapshot. |
| `friend_requests` | Directed sender/recipient request lifecycle. |
| `friendships` | Canonical accepted undirected relationship. |
| `friend_presence` | User's own expiring presence heartbeat. |
| `friend_activity_preferences` | Per-user preference for activity from a friend. |
| `blog_watchlist` | Per-user followed Codeforces bloggers. |
| `blog_entries` | Per-user cached blog entries/details. |
| `blog_entry_comments` | Per-user cached comments for an entry. |
| `blog_entry_state` | Per-user read/saved state and personal note for an entry. |
| `social_sync_state` | Per-user refresh watermarks and next-run schedule. |
| `social_notifications` | Per-user deduplicated in-app notifications. |

All 14 tables have RLS enabled in the migration and policies reference `auth.uid()`. It also creates friend-request and friendship helper functions/trigger. This is a separate, authenticated social store today; no inspected route connects those social `user_id` rows to SQLite training profiles.

### Cloudflare D1

`cloudflare/notifications-worker/migrations/0001_notification_schema.sql` defines six D1 application tables for the Web Push worker:

| D1 table | Role / current owner key |
|---|---|
| `notification_profiles` | Per-profile/per-browser-owner reminder settings, handle, daily-problem snapshot, and Codeforces verification/sync watermarks. |
| `notification_subscriptions` | Push endpoint and keys; composite FK to `(profile_id, owner_id)` in `notification_profiles`. |
| `notification_contests` | Shared cached Codeforces upcoming contests. |
| `notification_deliveries` | Per-profile/endpoint/notification idempotency and retry state. |
| `notification_worker_state` | Singleton contest refresh and lock status. |
| `notification_worker_runs` | Worker execution health/count/error history. |

The backend sends signed requests to the Worker for profile ensure/delete, reminder settings, subscriptions, and daily snapshots. The Worker owns actual scheduled delivery, cached contests, delivery claims/results, and worker status. The D1 binding/database ID is a placeholder in checked-in config; remote existence and contents were not checked. D1 is thus a third durable store for notification state when configured, not simply a cache.

The backend also has SQLite notification tables and a local notification service. Public notification routes use D1 when the Cloudflare bridge is configured and otherwise use SQLite. This is a live dual implementation selected by environment configuration; the current deployment's selection was not verified.

### Browser storage and file backups

These are additional persistence locations, not databases:

- `localStorage` stores browser client ID, saved/active handles, per-handle server-context snapshot, offline dashboard snapshot, private knowledge journal (`cp-coach:knowledge-journal:v1:*`), and virtual contest sessions (`cp-coach:virtual-contest:v1:*`). The latter two have their own versioned formats.
- The versioned JSON backup/export can contain training context, notes, and virtual contest data. In public mode, context import/export also reads/writes personal rows in server SQLite.
- `backups/cp_coach_backup_20261029_192648.db` is a checked-in-worktree file inventory item; it is an old SQLite copy, not an independently verified recovery point.
- `scripts/backup-db.js` copies only `cp_coach.db` and prunes old copies. Since the app enables WAL, a raw copy of only the main file is not a sufficient guarantee of a consistent live backup; use SQLite's online backup API (or a verified quiesced/checkpointed snapshot) in a future backup runbook.
- Render Free's configured `DB_DIR=/tmp/cp_coach` is ephemeral; it is not durable storage.

## 3. Complete current data-ownership map

| Data category | Current owner/source of truth | Additional copy/cache | Current access surface |
|---|---|---|---|
| Training profile, selected handle | Local SQLite `profiles` with null owner, or public SQLite `profiles` owned by browser client ID + handle | Browser saved-handle list and public context | `GET/POST /profiles`, select/delete; public variant requires client ID and handle |
| Daily recommendations and feedback | SQLite `daily_sets`, `daily_problems`; in public mode browser context is intended as the durable personal snapshot | Shared `problems`, curriculum; offline browser dashboard | `/dashboard`, `/daily`, `/training-plan`, `/problems/:id/open`, `/problems/:id/feedback`, `/daily/replace`, `/history`, `/context` |
| Learning journal, solve reflections, hints/editorial usage | SQLite `problem_learning_events`, `solve_sessions`; public browser context snapshot; knowledge journal notes are browser-only | Journal backfill copies some legacy daily/session/contest data into events; browser JSON backup | `/journal`, `/sessions/start`, `/sessions/:id/{hint,editorial,finish}`, `/sessions/analytics`; local knowledge-journal component |
| Review schedule | SQLite `review_queue`; public context snapshot | Some outcomes/events in `problem_learning_events` | `/reviews`, `/reviews/enqueue`, `/reviews/:problemId/action`, contest send-to-review |
| Weekly goals, learner state | SQLite `weekly_goals`, `learner_profile_state`; public context snapshot | Dashboard/offline browser snapshot | `/weekly-goals`, `/learner`, `/skill-tracks`, `/weekly-report` |
| Contest participation/reviews | SQLite `user_contests`, `contest_problem_reviews`; virtual contest sessions are browser-only | Shared Codeforces contest/problem cache; browser backup | `/contests`, `/contests/:contestId`, `/contests/:contestId/review`, `/contests/import`, `/contests/sync`, tutorials, history |
| Codeforces submissions, ratings, profile fields | External Codeforces API is authoritative; SQLite caches by handle | `submissions`, `rating_history`, `profile_cache`, `sync_meta`; social friend data has a separate owner cache | `/sync`, `/sync/status`, dashboard/analysis/contest routes; social friend endpoints |
| Curriculum/problem metadata | Source-controlled curriculum and public Codeforces are authoritative | SQLite shared `curriculum_problems`, `problems`, contest caches | `/curriculum`, `/tutorial/*`, dashboard/recommendation routes |
| Reminder preferences / subscriptions / delivery state | SQLite for local or unbridged public mode; Cloudflare D1 when its bridge is configured | SQLite and D1 schemas overlap; D1 gets a daily problem snapshot | `/notifications/*`; backend-to-Worker `/internal/v1/*`; Worker cron |
| Social account, friend graph, blogs, presence, social notifications | Supabase Auth identity plus Postgres social tables (intended; not verified live) | Codeforces API and Postgres user-scoped caches | `/api/social/*`; Supabase Auth session in frontend |
| Coach/student/group/assignment data | **No current implementation/store found** | None | No coaching routes or tables found |

### API surface that reads or writes state

The private `/api/*` router is mounted behind `requireApiToken` only when `COACH_API_TOKEN` is configured; local default mode can run without that token. In public mode, most `/api/public/*` calls are resolved to a profile by `X-Coach-Client-Id` and `X-Coach-Handle`. These are not authenticated Supabase identities.

The following is the complete Express route inventory in the inspected `routes.ts`, `publicRoutes.ts`, and `socialRoutes.ts`. Path prefixes are omitted inside the lists: prepend `/api` for the private router, `/api/public` for the public router, and `/api/social` for social. The public router installs the same `apiRouter` after its public-specific profile/context/notification handlers, so training endpoints are available under both prefixes. In `PUBLIC_MODE`, the same legacy `apiRouter` is also mounted at `/api/admin/*` only when an admin token is configured; otherwise that mount returns 404. The root `/health` is separate from the API routers.

- **Core API — reads:** `GET /profiles`, `/dashboard`, `/daily`, `/curriculum`, `/tutorial/:problemId`, `/contests/:contestId/problems/:problemIndex/tutorial`, `/learner`, `/history`, `/journal`, `/context`, `/network-info`, `/sync/status`, `/contests`, `/contests/upcoming`, `/contests/:contestId`, `/health`, `/skill-tracks`, `/weekly-report`, `/weekly-goals`, `/training-plan`, `/reviews`, `/sessions/analytics`, `/notifications/config`, `/notifications/subscriptions/status`, `/notifications/settings`.
- **Core API — writes:** `POST /profiles`, `/profiles/:id/select`, `/problems/:id/open`, `/problems/:id/feedback`, `/context`, `/sync`, `/contests/sync`, `/contests/import`, `/contests/:contestId/review`, `/contests/:contestId/problems/:problemIndex/send-to-review`, `/weekly-goals`, `/daily/replace`, `/reviews/enqueue`, `/reviews/:problemId/action`, `/sessions/start`, `/sessions/:id/hint`, `/sessions/:id/editorial`, `/sessions/:id/finish`, `/notifications/subscriptions`; `DELETE /profiles/:id`, `/notifications/subscriptions`; `PUT /notifications/settings`.
- **Public-specific routes:** `GET /health`, `/profiles`, `/handle/validate`, `/context`, `/network-info`, `/notifications/config`, `/notifications/settings`, `/notifications/subscriptions/status`; `POST /profiles`, `/profiles/:id/select`, `/context`, `/problems/:id/open`, `/problems/:id/feedback`, `/daily/replace`, `/reviews/:problemId/action`, `/sessions/:id/hint`, `/sessions/:id/editorial`, `/sessions/:id/finish`, `/notifications/subscriptions`, `/sync`, `/contests/sync`, `/contests/import`; `DELETE /profiles/:id`, `/notifications/subscriptions`; `PUT /notifications/settings`. These handlers add browser-owner resolution, explicit object checks, notification routing, and rate limits before the shared API router.
- **Social routes:** `GET /account`, `/codeforces/friends/online`, `/friends`, `/friends/requests`, `/presence/settings`, `/blogs/watchlist`, `/blogs/entries`, `/blogs/entries/:entryId`, `/blogs/entries/:entryId/comments`, `/notifications`; `POST /codeforces/link/challenge`, `/codeforces/link/verify`, `/friends/requests`, `/friends/requests/:id/respond`, `/presence/heartbeat`, `/blogs/watchlist`; `PUT /codeforces/credentials`, `/friends/:friendId/activity-notifications`, `/presence/settings`, `/blogs/entries/:entryId/state`; `DELETE /codeforces/link`, `/codeforces/credentials`, `/friends/:friendId`, `/presence/heartbeat`, `/blogs/watchlist/:handle`.
- **Notification Worker routes:** `GET /health`; bearer-protected `POST /internal/v1/profiles/ensure`, `/internal/v1/profiles/delete`, `/internal/v1/settings/get`, `/internal/v1/settings/update`, `/internal/v1/subscriptions/status`, `/internal/v1/subscriptions/register`, `/internal/v1/subscriptions/remove`, `/internal/v1/snapshots/sync`. The scheduled Worker handler also reads/writes D1 delivery, contest, and run state without an HTTP route.

- **Profile/configuration:** `GET/POST /profiles`, `POST /profiles/:id/select`, `DELETE /profiles/:id`; public equivalents use browser owner ID. Handle validation calls Codeforces rather than persisting learning state.
- **Dashboard/training reads:** `GET /dashboard`, `/daily`, `/curriculum`, `/learner`, `/history`, `/journal`, `/training-plan`, `/skill-tracks`, `/weekly-report`, `/reviews`, `/sessions/analytics`, `/contests`, `/contests/upcoming`, contest detail and tutorial routes. These read profile tables, learning tables, or shared cache/reference tables.
- **Training writes:** `POST /problems/:id/open`, `/problems/:id/feedback`, `/daily/replace`, `/sync`, `/contests/sync`, `/contests/import`, `/contests/:contestId/review`, `/contests/:contestId/problems/:problemIndex/send-to-review`, `/reviews/enqueue`, `/reviews/:problemId/action`, `/sessions/start`, `/sessions/:id/hint`, `/sessions/:id/editorial`, `/sessions/:id/finish`, `POST /weekly-goals`, and `POST /context`. Public routes perform explicit ownership checks for daily problem, review item, and solve session IDs; other routes rely on the resolved profile/request context.
- **Context import/export:** `GET/POST /context` exports/imports a versioned set of personal SQLite rows. Public browser local storage remains the restore source after an ephemeral backend restart. Import supports merge/replace and remaps some IDs; this behavior needs to be represented explicitly in the migration importer.
- **Notifications:** `GET /notifications/config`, `GET/PUT /notifications/settings`, `GET /notifications/subscriptions/status`, `POST/DELETE /notifications/subscriptions`. Public routes delegate these to Cloudflare D1 when configured, else SQLite. Daily snapshots are sent to the Worker after dashboard/daily/context/sync/feedback writes.
- **Social (`/api/social/*`):** `GET /account`; POST challenge/verify; DELETE Codeforces link; PUT/DELETE credentials; GET online Codeforces friends; GET friends and requests; POST/respond/delete friend requests/friend links; PUT friend activity notification preferences; GET/PUT presence settings; POST/DELETE heartbeat; GET/POST/DELETE blog watchlist; GET blog entries; PUT entry state; GET entry detail/comments; GET social notifications. These authenticate Supabase bearer tokens and transact against PostgreSQL with RLS claims.
- **Operational:** `/health` and `/api/public/health` read SQLite readiness; `/api/public/network-info` is not found; social auth/database failures return unavailable rather than falling back to SQLite.
- **Worker internal endpoints:** authenticated POSTs under `/internal/v1/` ensure/delete profiles, get/update settings, register/remove/check subscriptions, sync daily snapshots, and support scheduled delivery/status. The public Worker `/health` reports D1/VAPID readiness.

### Relationships and current gaps

- Most learner tables reference `profiles`; `daily_problems` also references `daily_sets` and shared `problems`.
- `user_contests`, `contest_problem_reviews`, `weekly_goals`, `review_queue`, `solve_sessions`, `learner_profile_state`, and journal events are profile-scoped.
- Several natural relations are not database-enforced: review/session/journal problem IDs, user-contest-to-shared-contest metadata, and Codeforces submissions-to-training-profile attribution are primarily joined by application logic/handle.
- The currently public API's browser client ID is a bearer-like browser identifier, not verified account proof, and localStorage clearing loses it. Same Codeforces handle does not prove that two stores belong to the same person.
- No single durable owner spans SQLite, Postgres, D1, and browser storage. There is no coaching relationship model.

## 4. Recommended target architecture and proposed PostgreSQL schema

Use a single Supabase project in a Europe region (Frankfurt is available) for Auth and application PostgreSQL. Supabase `auth.users.id` UUID is the immutable principal. Keep application tables in a non-PostgREST-exposed schema such as `app` where practical; expose only narrowly scoped safe views/RPCs if direct frontend data access is later required. The frontend may use the Supabase public/anon key for Auth only. All application writes go through the Node API until data ownership and RLS are verified.

All user-owned records should contain `user_id UUID REFERENCES auth.users(id)` and, where profile-scoped, a `training_profile_id`. Add a unique parent key `(id, user_id)` to `training_profiles` and composite FKs `(training_profile_id, user_id)` on child rows. This prevents a caller from combining one user's profile ID with another user's owner ID. Use UUID IDs for new rows, UTC `timestamptz` event times, `date` for training-day/week boundaries, explicit `CHECK`s/enums for status values, and `ON DELETE` behavior reviewed per data-retention requirements.

### Proposed schema groups

| Schema/table group | Proposed entities and important constraints |
|---|---|
| Identity and preferences | Supabase `auth.users`; `app.user_profiles(user_id PK, display_name, created_at, updated_at)`; `app.user_preferences(user_id PK, timezone, locale, privacy/default settings)`. Do not duplicate email/password. |
| Training profile | `app.training_profiles(id UUID, user_id, codeforces_handle, display_name, is_default, created_at, updated_at, UNIQUE(id,user_id))`; index/unique `(user_id, lower(codeforces_handle))`. Allow a user to maintain multiple profiles without making a Codeforces handle a global account key. |
| Shared reference data | `app.problems(problem_key PK, contest_id, problem_index, name, rating, tags, updated_at)`; `app.curriculum_problems` with versioned topic/stage/objective/prerequisites; `app.codeforces_contests` and contest problem metadata. Authenticated users get read-only access; writes are ingestion/migration-only. |
| External Codeforces snapshots | `app.codeforces_submissions(training_profile_id,user_id,submission_id,problem_key,verdict,created_at,raw_fields, fetched_at, PK(training_profile_id,submission_id))`; `app.codeforces_rating_changes(training_profile_id,user_id,contest_id,...)`; `app.codeforces_profile_cache` (shared, strictly TTL/cache data) if sharing cache is beneficial. Keep request data scoped to the user's selected handle and mark external-derived data/cache separately from learner claims. |
| Daily training | `app.daily_sets(id, training_profile_id,user_id,local_date,generated_at, UNIQUE(training_profile_id,local_date))`; `app.daily_problems(id,daily_set_id,training_profile_id,user_id,problem_key,category,reason,target_rating,opened_at,attempted,verified_ac,feedback fields, updated_at, UNIQUE(daily_set_id,problem_key))`. FKs ensure profile/owner consistency. |
| Learner state and journal | `app.learner_profile_state(training_profile_id,user_id,schema_version,data_json,updated_at)` as a compatibility landing table initially; `app.problem_learning_events(id,training_profile_id,user_id,problem_key,source,source_key,occurred_at,feedback/reflection/evidence fields, UNIQUE(training_profile_id,source,source_key))`. Normalize learner state only after semantics are fully mapped. |
| Solve sessions | `app.solve_sessions(id,training_profile_id,user_id,problem_key,started_at,ended_at,duration_seconds,hints/editorial/outcome/reflection fields)`; indexes `(training_profile_id,started_at DESC)` and `(training_profile_id,problem_key,started_at DESC)`. |
| Reviews | `app.review_queue(id,training_profile_id,user_id,problem_key,source,due_date,interval_days,repetition_count,state,last_reviewed_at,review_notes, UNIQUE(training_profile_id,problem_key))`; add `app.review_events` append-only rows for each reviewed outcome/schedule transition going forward. Index `(training_profile_id,state,due_date)`. |
| Goals and contest participation | `app.weekly_goals(id,training_profile_id,user_id,week_start_date,target counts,focus_topics,notes, UNIQUE(training_profile_id,week_start_date))`; `app.user_contests(id,training_profile_id,user_id,contest_id,participation/results/report, UNIQUE(training_profile_id,contest_id))`; `app.contest_problem_reviews(id,training_profile_id,user_id,contest_id,problem_index,review/upsolve fields, UNIQUE(training_profile_id,contest_id,problem_index))`. |
| Social | Retain/rework the existing `social_profiles`, `codeforces_link_challenges`, encrypted `codeforces_credentials`, `codeforces_friends_cache`, `friend_requests`, `friendships`, `friend_presence`, `friend_activity_preferences`, blog watchlist/entry/comment/state, and sync state. Use `auth.users.id` consistently. Make friend discovery a limited-field view/RPC, not broad table-row SELECT. |
| Coaching | `app.coach_student_links(coach_user_id,student_user_id,status,requested_at,accepted_at,revoked_at)`; `app.training_groups(id,coach_user_id,name,...)`; `app.group_memberships(group_id,student_user_id,status,...)`; `app.assignments(id,coach_user_id,group_id NULL,title,instructions,due_at,created_at)`; `app.assignment_targets(assignment_id,student_user_id,training_profile_id)`; `app.assignment_problems(assignment_id,problem_key,position)`; `app.assignment_progress(assignment_problem_id,student_user_id,status,completed_at,reflection)`; `app.student_shares(student_user_id,coach_user_id,scope,granted_at,revoked_at)`. Require student acceptance for a coach link and explicit scope grants for non-assignment performance/journal data. |
| Notifications | `app.notification_preferences(user_id,training_profile_id NULL,contest_reminders,daily_reminders,reminder_time,timezone,updated_at)`; `app.push_subscriptions(id,user_id,training_profile_id NULL,endpoint_hash UNIQUE,endpoint,p256dh,auth,active,created_at,updated_at)`; `app.notifications(id,user_id,event_key,kind,title,body,href,is_read,created_at, UNIQUE(user_id,event_key))`; `app.notification_deliveries(id,user_id,subscription_id,notification_key,status,attempted_at,sent_at,retry_after,error_code, UNIQUE(subscription_id,notification_key))`. Restrict push endpoint/key reads to owner and trusted delivery service. |
| Synchronization and migration | `app.sync_state(training_profile_id,user_id,source,last_success_at,next_attempt_at,last_error_code,updated_at)`; use Postgres advisory locks or short-lived lease rows for job coordination. A restricted `app.migration_crosswalk(source_system,source_owner_key,source_profile_id,source_table,source_row_key,target_user_id,target_profile_id,target_row_id, UNIQUE(source_system,source_owner_key,source_table,source_row_key))` supports idempotent imports and audit. |

Only durable user state belongs in these canonical tables. Cache/API snapshots and rate-limit/sync leases need TTLs and can be rebuilt. A cache miss or external API outage must not delete user history or make an accepted submission appear as a self-reported solve. Do not write durable application state to D1 once the Postgres cutover is complete.

## 5. Authentication, authorization, and RLS design

1. **Canonical identity:** create an account through Supabase Auth; use the verified JWT subject (`auth.users.id`) as the only user ID. Never derive ownership from a Codeforces handle, display name, email string, profile ID, browser client ID, or caller-supplied `user_id`.
2. **API boundary:** require and verify Supabase JWTs for all account-owned training/social/coaching API routes. Remove public training writes keyed only by `X-Coach-Client-Id` as part of the future cutover; retain a controlled import/export transition, not an indefinite anonymous write architecture. The frontend must never receive DB passwords, service-role keys, credential-encryption keys, or a token that bypasses user RLS.
3. **Database role:** use a backend connection that cannot bypass RLS. In each transaction, set the verified subject/role as transaction-local claims, then run as a role with only necessary table grants and no `BYPASSRLS`. Do not trust caller-provided claims. Verify Supabase pooler role switching and transaction-local claims on staging before selecting this connection pattern; alternatively use Supabase's PostgREST/RPC with the user's JWT. Never use a long-lived service-role connection for ordinary user requests.
4. **RLS default deny:** enable and `FORCE ROW LEVEL SECURITY` on owned tables. Owner policies use `user_id = (select auth.uid())`; profile child policies additionally require an owned `training_profiles` parent. Do not rely solely on endpoint filtering or UUID secrecy.
5. **Coaching:** student-owned personal rows stay private by default. Coaches may read assignment targets/progress they own and only approved summaries/records covered by a current student grant. Group membership alone must not grant access to journals, full solve history, credentials, or personal notes. Use narrowly scoped server functions/views with fixed `search_path`, explicit coach/student relationship checks, and auditable access. Revocation must take effect immediately.
6. **Social:** participant-only request visibility; accepted-friend-only relationship/presence reads; only the owner can mutate their preferences, credentials, and caches. Discovery returns only explicitly public discovery fields. Postgres RLS is row-level, not column-level: use views/RPCs and column grants to avoid revealing private preference fields when a profile is discoverable.
7. **Reference and operational data:** shared problem/curriculum tables are authenticated read-only; ingestion writes use a separate restricted role. Sync/cache state is scoped to the profile owner; global worker coordination has no user-facing SELECT policy.
8. **Push and secrets:** store delivery endpoints and key material only in owner-restricted tables; never include them in normal profile responses/logs. Keep Codeforces credentials encrypted with a server-only key, rotate/backup that key securely, and document key-loss consequences.
9. **Testing requirement:** test policies with at least two ordinary authenticated users and one coach/student pair through the same application role used in production. Test both SELECT and INSERT/UPDATE/DELETE, cross-profile composite-FK attacks, group members who are not assigned students, revoked shares, and table-owner/service-role bypass assumptions.

### Existing Supabase migration readiness findings

The migration is useful as a draft schema, but is not ready to be treated as the final production migration:

- It adds only social tables, not training, notifications as a consolidated model, coaching, or SQLite-to-Postgres data migration.
- It has not been applied to disposable staging, type/constraint checked against the selected Supabase project, or tested under the actual transaction-pooler role.
- `CREATE TABLE IF NOT EXISTS` does not make the entire migration rerunnable: policies, functions, and trigger creation are not guarded/idempotent; there is no verified rollback migration.
- Policies are row-level; `social_profiles` discovery needs a column-exposure review. RLS does not protect against privileged table-owner/service roles.
- The backend currently sets `app.cp_coach_backend` as a custom transaction setting. Treat that as a server-internal marker only; do not treat a user-settable GUC as an independent security boundary. Confirm how SQL role permissions and JWT claims interact under the real pooler.
- Friend-request transitions, friend visibility, and credential operations need adversarial multi-user integration tests; source inspection alone is not proof of isolation.
- No schema reset, migration application, or remote status check was performed.

## 6. Safe migration and rollback plan

Migration is a later, separately approved implementation project. No step below has been performed.

### Phase A — establish ownership and source snapshots

1. Inventory the actual deployed SQLite DB path, WAL state, Render plan/storage, D1 database, Supabase project/schema, browser backup versions, and user counts with the owner. Do not infer the live source from checked-in config.
2. Choose a maintenance/cutover window and a declared export format/version. Freeze source writes during final extraction; do not maintain two-way dual writes.
3. Make verified, encrypted recovery copies before extraction: use SQLite's online backup API for each SQLite DB, export relevant D1 tables using the supported D1 export, and record Supabase migration history/data before any schema change. Verify each backup by opening/restoring a copy in an isolated environment and checksumming it.
4. For browser-only knowledge notes, virtual contests, offline snapshots, and backups, require a user-initiated export/import or an explicit application sync while the source browser still has the data. A remote operator cannot reconstruct cleared localStorage.
5. Never export plaintext Supabase auth secrets, Codeforces API credentials, push endpoint keys, or other credentials into CSV/logs. Existing encrypted social credentials need the correct encryption key; without it they cannot safely be re-encrypted or recovered.

### Phase B — account and profile identity crosswalk

1. Create a staging Auth user for each consenting learner; target `auth.users.id` is canonical. Preserve a restricted old-owner/profile-to-new-user/profile crosswalk.
2. **Public SQLite:** `profiles.owner_id` is the old browser client ID. Prove control through the existing browser/session or a user-approved versioned export; do not map by Codeforces handle alone. When proof is unavailable, quarantine the records for user claim/support instead of assigning them to the apparent handle owner.
3. **Local SQLite profiles with `owner_id IS NULL`:** treat as an explicitly assigned local account/owner. Do not infer that a profile belongs to a student from a public handle or data contents.
4. **Supabase social users:** retain the existing Auth UUID for the same verified account if the selected Supabase project remains the production Auth project. Otherwise require a separately planned Auth-user migration; never assume UUIDs are portable across unrelated projects.
5. If several browser IDs contain the same handle, preserve separate source profiles until the account owner explicitly chooses merge. Keep distinct learner histories separate even when they refer to one Codeforces handle.
6. Map each old profile ID to a new `training_profiles.id`; remap all child FKs using that crosswalk. Keep the old source key in the migration crosswalk, not as the new ownership identity.

### Phase C — table mapping and transformation

| SQLite/D1/browser source | Target handling |
|---|---|
| `profiles` | `training_profiles`; map `owner_id` via approved user crosswalk, normalize/validate handles, preserve display/rating fields as cached metadata. `settings.active_profile_id` becomes per-user default/selection preference, not global state. |
| `daily_sets`, `daily_problems` | `daily_sets`, `daily_problems`; map profile and problem keys, preserve actual open/attempted/verified flags and all feedback. Do not convert an opened assignment into a solved/accepted event. |
| `problems`, `curriculum_problems`, `contest_problems_meta`, `codeforces_contests` | Shared target catalog tables; normalize `${contest_id}_${problem_index}` and use canonical contest/index constraints. Verify any embedded/JSON tags and prerequisites. Refetch public metadata only after preserving user-authored links/references. |
| `learner_profile_state` | Versioned JSONB landing table first; validate JSON shape and handle. Do not discard unknown keys or normalize fields without compatibility tests. |
| `problem_learning_events`, `solve_sessions` | Same target concepts; preserve event source and evidence. Scope source-key dedupe by profile/source. Validate timestamps and don't treat self-reports as Codeforces ACs. Avoid counting legacy backfill plus source rows twice. |
| `review_queue` | `review_queue`; preserve current interval, due date, repetition count, state, and notes. Create review event history only from evidence actually present; do not fabricate prior outcomes. |
| `weekly_goals` | `weekly_goals`; preserve local week-start date, timezone semantics, counts, focus list, and notes. Check unique profile/week collisions before insert. |
| `user_contests`, `contest_problem_reviews` | Corresponding user-owned contest tables; preserve participation type, rating results, report JSON and upsolve details. Validate every referenced problem and submission ID. |
| `submissions`, `rating_history`, `profile_cache` | Move only the useful, bounded cache window; preserve handle association and fetched time. Rebuildable data can be refetched. Do not use shared caches as a user's identity or import one user's evidence into another profile. |
| `sync_meta`, `sync_leases` | Rebuild sync timestamps as `sync_state`; discard expired process leases after audit. Do not migrate process owner IDs as user IDs. |
| SQLite `notification_settings`, `push_subscriptions`, `notification_deliveries` | Map to canonical Postgres notification tables using verified profile/user crosswalk. Detect overlap with D1 before merge. Transfer delivery dedupe/retry states idempotently; encrypt/restrict subscription keys. |
| D1 `notification_profiles` | Map settings and profile identity; rebuild `daily_snapshot` from migrated current daily assignments rather than trusting a potentially stale JSON snapshot, then compare and report differences. |
| D1 `notification_subscriptions`, `notification_deliveries` | Map only after resolving SQLite/D1 duplicates using endpoint hash + profile + notification key; retain delivery status and avoid sending the same notification again during cutover. |
| D1 `notification_contests` | Rebuild from Codeforces; cache only. |
| D1 `notification_worker_state`, `notification_worker_runs` | Archive bounded operational history if required; do not treat as learning data. Replace locks with Postgres advisory locks/short leases. |
| Browser `knowledge-journal` and `virtual-contest` data | User-initiated export/import to new user/profile IDs. Validate supported format/version and handle; preserve timestamps/contest IDs. |
| `localStorage` context/offline snapshots and JSON backups | Import via the existing validation/merge path redesigned for target IDs. Deduplicate with source crosswalk; never silently replace a newer server row with stale offline state. |
| Supabase social tables | Retain the same authenticated user IDs when project continuity allows; review constraints/policies and migrate to the reviewed final schema. Ensure social Codeforces credentials are decryptable and re-encrypted with the target key before switching. |

### Duplicate detection and validation gates

- Compare source and target row counts by table, owner, profile, and status; record intentional exclusions and transformations.
- Produce collision reports before inserts for `(owner, lower(handle))`, `(profile, date)`, `(daily_set, problem)`, `(profile, problem)` review rows, `(profile, week_start)`, `(profile, contest)`, and `(profile, contest, problem_index)`.
- Canonicalize problem keys only after validating contest/index; do not merge on problem name alone.
- For conflicting user-authored notes, feedback, or goals, preserve both in a conflict artifact or require user resolution; don't pick an arbitrary latest timestamp when timestamp validity is uncertain.
- Check all FK orphans, user/profile composite-FK mismatches, invalid statuses, timestamps, JSON parseability, time-zone/day boundaries, verified-AC provenance, and per-owner deduplication.
- Compare stable row hashes (excluding target IDs and expected transformed timestamps) for every migrated table; verify note/session/assignment counts and aggregate contest/review statistics.
- Run importer twice in disposable staging and prove idempotency; repeat with interrupted batches and resume.
- RLS acceptance gate: user A cannot read or alter user B's profiles, histories, notes, schedules, goals, subscriptions, social credentials, or notifications; coaches see only their own assignments and student-granted scope; revoked access fails immediately.
- Re-run recommendation, backup/export-import, Codeforces cache/sync, notification dedupe, and public/private API tests against Postgres staging before release.

### Cutover and rollback

1. Deploy schema/code to isolated staging only; use separate Auth project, DB, API secrets, Codeforces test accounts, and notification keys.
2. Restore anonymized/synthetic or explicitly approved data into staging and complete all validation/security/backup drills.
3. For production: take and verify final source snapshots; set source into maintenance/read-only mode; run an idempotent final delta import; compare counts/hashes; run smoke tests; then switch traffic and keep SQLite/D1 snapshots untouched and read-only.
4. Do not dual-write indefinitely. If cutover fails before target writes are accepted, switch back to the untouched source deployment. If target writes have started, freeze writes and either forward-fix or perform a separately tested reverse/delta export; never discard target-only writes or blindly restore an older backup.
5. Retain encrypted, access-controlled pre-cutover backups and migration logs for an approved retention period. Perform a restore drill into a disposable project. Delete/retire old stores only after a separately approved retention and recovery review.

## 7. Hosting recommendation for ~20 users

| Component | Option | Reliability/storage/region | Cost signal and decision |
|---|---|---|---|
| PostgreSQL + Auth | Supabase Pro | Durable managed PostgreSQL; paid projects are not paused for inactivity; daily backups (7-day retention per current pricing page); Frankfurt region available. Use a single project for Auth and app DB. | $25/month starting price; Pro includes $10/month compute credits covering a Micro instance. Confirm current quotas, backup/restore features, egress, and region before purchase. **Recommended database.** |
| Node API + background work | Railway Hobby | Always-on service with metered CPU/RAM; persistent volumes exist but are unnecessary for durable application state. Amsterdam region available. Keep one API/background process initially; Postgres advisory locks make scheduled work safe. | $5/month plan includes $5 usage; currently published rates are $10/GB-month RAM, $20/vCPU-month CPU, $0.15/GB-month volume, $0.05/GB egress. A single 0.5 GB RAM service plus modest average CPU suggests roughly $7-$15/month total depending CPU use/egress; validate after a month. **Recommended backend for simple operation.** |
| Node API alternative | Render paid web service | Frankfurt region available; paid persistent disks are single-instance and cause redeploy downtime. With Postgres as source of truth, no service disk is needed. Render Free sleeps after 15 min inactivity, takes about a minute to wake, and loses local filesystem writes. | Free is rejected for production. A current paid quote should be checked in Render's dashboard; pricing could not be verified reliably from its dynamically rendered public page during this audit. Reasonable alternative if current service continuity matters. |
| Static frontend | Vercel Hobby | Global static hosting/CDN; no durable user data should be stored exclusively on Vercel. | $0 if project/account use meets Hobby eligibility and included limits; Vercel Pro is listed at $20/month if needed. Confirm current terms/plan limits for the intended student use. |
| Scheduled notifications | Existing backend worker | Run from the always-on backend and persist all preferences/deliveries in Postgres. Use a Postgres advisory lock or durable lease to avoid duplicate work. | No separate D1 operating cost. Cloudflare Worker could remain a scheduler-only trigger later, but do not retain D1 as a parallel canonical database. |

**Estimated baseline:** approximately **$32-$40/month before tax, egress, overages, and backup-storage expansion**: Supabase Pro ($25) plus a small Railway backend (estimated $7-$15) plus static Vercel Hobby ($0, if eligible). If Vercel Pro is required, add the currently listed $20/month. This is a planning range, not a quote or authorization to create a paid service. A separately stored encrypted backup copy may add cost depending on provider/retention. No provider resource should be created before explicit approval.

The Frankfurt/Amsterdam combination is geographically reasonable for the current project and avoids keeping the backend in the current Oregon Render region. Place the DB and API as close as practical, confirm actual provider region choices at provisioning, and check latency from the intended student locations. Provider availability is not an uptime SLA; document service-specific limits and restore procedures.

Official pages checked 2026-11-03: [Supabase pricing](https://supabase.com/pricing), [Supabase regions](https://supabase.com/docs/guides/platform/regions), [Railway pricing](https://railway.com/pricing), [Railway regions](https://docs.railway.com/deployments/regions), [Render Free limitations](https://render.com/docs/free), [Render disks](https://render.com/docs/disks), [Render regions](https://render.com/docs/regions), [Vercel pricing](https://vercel.com/pricing).

## 8. Risks and unresolved decisions

1. **Live topology is unverified:** the selected production DB, Render storage plan, D1 deployment, and Supabase project state were not inspected through provider credentials. Current checked-in files may not equal active infrastructure.
2. **Identity cannot be inferred:** public SQLite records use a browser client ID; some browser-only data may exist only on a device. Losing that device/export may make data unrecoverable. User claim/consent process and account invitation policy need approval.
3. **Local profile ambiguity:** SQLite `owner_id IS NULL` profiles may be personal development records. Assign each intentionally; do not import all into a student account by handle.
4. **Legacy schema drift:** SQLite upgrades happen at process startup; the active file may have historical columns/data differences. Inspect schema and take a verified backup before any future import.
5. **Notification duplicates:** SQLite and D1 can both contain reminder preferences, subscriptions, and delivery status. Determine which source was active and reconcile before moving endpoints or delivery ledgers.
6. **Social migration safety:** unverified RLS/role switching, migration non-idempotency, hidden column exposure, Codeforces encryption key custody, and whether the same Supabase Auth project will remain in use need resolution.
7. **Coaching permissions:** define coach invitation, student consent, share scopes, group membership, assignment ownership, guardian/minor requirements if relevant, data retention, and audit expectations before schema implementation.
8. **Backup consistency:** current SQLite backup script uses a plain file copy while WAL mode is enabled. Postgres backups need an independently stored export/restore drill in addition to provider-managed backups.
9. **Data residency / cost:** confirm required country/region, account eligibility, provider limits/terms, expected notification volume, and budget. The cost estimate excludes email delivery, domain, taxes, and usage overages.
10. **Cutover behavior:** choose the public transition model (require accounts immediately, or a time-limited guest export/import window) and define what happens to inactive/unclaimed browser profiles.

## 9. Exact next implementation steps

1. Review and approve the proposed canonical Auth identity, ownership/claim rules, account transition, region, providers, and budget.
2. Provide explicit approval before creating isolated staging resources. Do not use existing production credentials or projects as a staging shortcut.
3. Build a schema inventory/ERD and migration manifest from the final reviewed SQLite and social schemas; fix the online backup strategy before using it.
4. Prepare versioned PostgreSQL migrations for the complete target schema, with idempotent deployment ordering, rollback notes, restricted roles, RLS, and separate migration-only privileges. Do not apply to production.
5. Implement Auth-required application API interfaces and PostgreSQL repositories behind feature/config gates, with no production SQLite fallback and no long-lived service-role bypass.
6. Add fixtures and integration tests for owner isolation, profile composite FKs, social privacy, coach/student consent, assignment permissions, notification endpoint privacy, and transaction pooler claims.
7. Build a dry-run importer that reads verified SQLite/D1/browser exports, generates crosswalks/conflict reports, validates counts/hashes/FKs, and can be safely rerun against disposable staging.
8. Run the staging migration, restore/rollback drills, app/API smoke tests, notification delivery dedupe tests, and multi-user RLS tests; document actual results.
9. Obtain separate approval for production snapshot, maintenance window, final delta migration, traffic switch, DNS (if any), and retention/cleanup. Do not retire SQLite or D1 before recovery acceptance.

## Final recommendation

Adopt **Supabase PostgreSQL as the only durable application database**, Supabase Auth UUID as the only user identity, and a stateless/replaceable Node API with RLS-checked transactions. Keep shared Codeforces data as rebuildable caches, and keep notification execution in the backend rather than a second durable D1 store. Use explicit student ownership/consent for coaching access. Migrate only after verified identity mapping, consistent backups, disposable staging, and cross-user RLS tests pass.

**Wait for review and explicit approval before modifying database infrastructure, applying any migration, creating paid resources, deploying, or moving production data.**
