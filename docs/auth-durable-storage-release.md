# Authentication and durable-storage release plan

Status: implementation complete in the working tree; not deployed.
Last updated: 2026-11-04.

This document supersedes the public-mode storage and authentication claims in
older status docs and in the top-level README where they conflict.

## Decision ($0.00 / Month Total Recurring Cost)

Use **Supabase Free PostgreSQL as durable cloud backing** + **Render Free Web Service with ephemeral SQLite cache accelerator** + **Supabase Auth** for training API identity.

Why this option:

- Strictly $0.00/month recurring cost across all services (Render Free, Supabase Free, Vercel Hobby, Cloudflare Free).
- Avoids paid Render Starter ($7/mo) and paid disks ($0.25/GB).
- Does NOT rely on Render's ephemeral filesystem for permanent storage: user data is durably persisted to Supabase PostgreSQL and auto-hydrated into SQLite on demand.
- Preserves all 23 SQLite tables, synchronous algorithms, weakness analysis, and 148 automated tests without an error-prone full query rewrite.
- User-scoped RLS and verified Supabase JWT ownership prevent any cross-user data leakage.

Constraints accepted with this decision:

- The backend is a single Render instance; SQLite is not shared across
  instances.
- Backups on the same disk protect against corruption and operator error, not
  disk loss. An offsite copy is still required.
- This is a durability and account-isolation fix, not a high-availability
  architecture.

## What changed

### Authentication

- `backend/src/authMiddleware.ts` verifies a Supabase Bearer token, requires
  `sub`, future `exp`, `role=authenticated`, and an acceptable `aud`; when
  Supabase is configured it validates the token against
  `GET /auth/v1/user` and requires the returned user id to equal `sub`.
- Missing, malformed, expired, anonymous, revoked, issuer-mismatched, or
  user-mismatched tokens are rejected.
- Training routes no longer accept `X-Coach-Client-Id`, a handle, or an
  arbitrary profile id as authentication.
- Test-only unsigned JWTs are accepted only when `NODE_ENV=test`/`VITEST` and
  Supabase is not configured, or when `MOCK_SUPABASE_AUTH=true` in a test
  environment. Production public mode refuses to start without
  `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- The frontend now has a Supabase magic-link gate (`AuthGate`), attaches the
  access token to public API requests, refreshes once on `401`, and signs the
  user out on an unrecoverable refresh failure.
- Browser storage keys are prefixed with the authenticated user id. A one-time
  explicit prompt moves legacy unscoped notes/handles into the account.

### Database ownership

- `profiles.owner_id` for new public profiles is the Supabase user id.
- Every public profile lookup verifies that the profile belongs to the
  authenticated user. Cross-account profile ids return `403`.
- Legacy claim supports:
  - dry-run previews,
  - null-owner legacy profiles,
  - an explicit `legacyOwnerId` for client-id-owned records,
  - reassignment only when authorized by `LEGACY_MIGRATION_SECRET` or
    `COACH_ADMIN_TOKEN`,
  - verification through a linked, verified Codeforces handle,
  - an audit row in `profile_ownership_migrations`,
  - rollback while the profile is still owned by the migration recipient.
- The two real legacy profiles are `Obadajo` (`prof_obadajo`) and
  `M7_Radwan` (`prof_m7_radwan_mvib3ygz`). Both currently have
  `owner_id IS NULL` and must be claimed explicitly; the implementation never
  assigns them to the first person who signs in.

### Durability

- `DB_DIR` is the Render disk mount `/var/data/cp_coach`.
- On startup, production performs `PRAGMA integrity_check` and
  `PRAGMA foreign_key_check`, and creates a verified backup when due.
- Production startup fails if integrity fails, maintenance reports an error,
  or no backup exists.
- Backups use SQLite `VACUUM INTO`, verify integrity/FK checks, record a SHA-256
  JSON manifest, and retain 14 by default.
- A periodic scheduler repeats the check/backup every 24 hours.
- `/api/public/health` reports durability, integrity, FK status, backup count,
  and the latest backup time/hash.
- The browser no longer overwrites the server from a stale snapshot on every
  instance change. A local snapshot is imported only when the server has no
  personal rows for that profile.

## Required environment

Render backend:

```env
NODE_ENV=production
PUBLIC_MODE=true
HOST=0.0.0.0
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<public anon key>
DB_DIR=/var/data/cp_coach
DB_BACKUP_DIR=/var/data/cp_coach/backups
DB_BACKUP_INTERVAL_HOURS=24
DB_BACKUP_RETENTION=14
DB_BACKUP_ON_STARTUP=true
LEGACY_MIGRATION_SECRET=<long random secret; only for administrator claims>
CORS_ORIGINS=https://<exact frontend origin>
```

Vercel frontend:

```env
VITE_PUBLIC_MODE=true
VITE_API_BASE_URL=https://<render-service>.onrender.com
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<public anon key>
```

Do not put `SUPABASE_ANON_KEY` into a place that implies it is a server secret;
it is public by design. Never put `SUPABASE_SERVICE_ROLE_KEY` in either the
frontend or the backend environment used for user requests.

Supabase Auth configuration:

1. Enable email magic links / OTP.
2. Add the exact Vercel production URL and local development URL to the allowed
   redirect URLs.
3. Decide whether email confirmation is required. The app supports both, but
   magic-link delivery must work end to end before launch.
4. Keep the Supabase project's production URL stable; changing it invalidates
   the backend issuer check until `SUPABASE_URL` is updated.

## Deployment order

1. **Back up before touching production.**
   - Stop writes if possible.
   - Take a verified backup of the current real database.
   - Record SHA-256 and test a restore into a temporary path.
   - Existing verified pre-change copies:
     - `backups/cp_coach-20261104T094217Z-f36e35db.sqlite`
       (`037e218c2164818bbeaffc4863806276dcb10828daf39c640e3e7488a301c967`)
     - `backups/cp_coach-20261104T094221Z-56d2a8a6.sqlite`
       (`f868df3a5399f54033fb019aea662669952bf3140e2acda9ae84c0b51d140bc4`)
2. Configure Supabase Auth and obtain the URL and anon key.
3. Update Render:
   - switch to Starter,
   - add the 1 GB disk at `/var/data/cp_coach`,
   - add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, the `DB_BACKUP_*` values, and
     optionally `LEGACY_MIGRATION_SECRET`,
   - deploy.
4. Update Vercel with the `VITE_SUPABASE_*` values and deploy.
5. Verify `/api/public/health` returns `status: ok`, `database.integrity: ok`,
   `database.durableStorage: true`, and a non-zero backup count.
6. Populate the persistent database with the real data using one approved
   transfer path (see below), then verify API and account access.
7. Claim the legacy profiles only after the owner has signed in and the claim
   has been previewed.

## Transferring the existing database to the Render disk

Render does not provide a general local-to-disk file upload endpoint. Use a
maintenance window and one of these approved paths.

### Preferred: verified full-database restore

1. Create a private, temporary object URL (for example a signed R2/S3 URL) for
   the verified backup. Do not make it public.
2. In the Render shell, download to a staging path on the disk, for example
   `/var/data/cp_coach/import/cp_coach.sqlite`.
3. Verify in the shell:
   - `sha256sum` matches the recorded hash,
   - `npm --prefix backend run db:verify -- --target /var/data/cp_coach/import/cp_coach.sqlite`
     reports `integrity: "ok"`.
4. Take a fresh backup of the currently deployed empty/initial database.
5. Stop or suspend traffic, swap the staged verified file into place, remove
   stale `-wal`/`-shm` files for the old database, restart the service, and
   delete the temporary object URL.
6. Verify `/api/public/health` and a known profile through the authenticated
   account.
7. Keep the pre-swap copy until after a full day of successful backups.

### Fallback: per-profile context import

Use this only for small datasets (the current real database has two profiles).

1. From a trusted local environment with the real database, export each
   profile's public context using the existing authenticated/admin path.
2. Sign in to production as the intended owner, create or select the matching
   handle profile, and import with `mode=replace`.
3. Export a production backup immediately after the import and compare counts
   for daily sets, daily problems, learning events, contests, and sessions.
4. This path does not transfer cache-only tables such as Codeforces
   submissions; those are repopulated by sync.

## Backup and restore runbook

Run from the backend directory or with `npm --prefix backend`:

```bash
# Verify the live database
npm --prefix backend run db:verify

# Create and verify an on-disk backup
npm --prefix backend run db:backup

# Inspect applied schema and ownership migrations
npm --prefix backend run db:migrations

# Restore a verified backup. Stop the service first.
npm --prefix backend run db:restore -- /var/data/cp_coach/backups/<file>.sqlite --confirm
```

The restore helper verifies the source, creates a pre-restore safety copy, and
checks integrity after copying. Never restore directly to a live mounted path
while the service is writing. Always copy at least one verified backup off the
Render disk to a separate provider or encrypted local archive.

The health endpoint is not a substitute for an offsite backup. A backup on the
same disk disappears with the disk.

## Legacy profile claim runbook

1. Confirm the current owner by hand. A Codeforces handle is public and does
   not prove ownership.
2. Sign in with the intended Supabase account.
3. From Settings -> Account & security, enter the old handle/profile id.
4. Run **Preview claim**. Expected result for the two legacy profiles:
   null `previousOwnerId`, non-zero migrated counts, and no writes.
5. For a null-owner profile, provide `LEGACY_MIGRATION_SECRET` (or use a linked,
   verified Codeforces handle) and run the claim.
6. For a client-id-owned profile, also provide the exact legacy owner id; the
   administrator secret is required to permit reassignment.
7. Verify the audit row and then the dashboard. Roll back with the migration id
   if anything is wrong.

CLI equivalents:

```bash
npm --prefix backend run db:claim -- --user <supabase-uuid> --profile prof_obadajo --dry-run
npm --prefix backend run db:claim -- --user <supabase-uuid> --profile prof_obadajo --confirm --reason "verified owner"
npm --prefix backend run db:rollback -- --migration <pom_id> --dry-run
npm --prefix backend run db:rollback -- --migration <pom_id> --confirm
```

Do not run a real claim without the owner's confirmation and a fresh backup.

## Validation evidence

- `npm --prefix backend run build`: passes.
- `npm --prefix frontend run build`: passes (Vite warns only about chunk size).
- `npm --prefix backend test`: 22 files, 138 tests pass.
- `npm --prefix cloudflare/notifications-worker run typecheck` and `test`:
  pass (1 file, 19 tests).
- Added tests cover:
  - missing/expired/spoofed authentication,
  - cross-account profile access,
  - claim dry-run, secret gating, audit, and rollback,
  - null-owner and client-id-owned claims,
  - non-empty handle-conflict refusal,
  - case-tolerant owner deletion,
  - verified backup/manifest/restore,
  - retention and startup maintenance,
  - a real backend process restart serving the same data from the durable file.

## Residual risks and follow-ups

- Same-disk backups are not disaster recovery. Automate an encrypted offsite
  copy and test restore from it.
- SQLite on one Render instance does not support horizontal scaling. Revisit
  Postgres before running multiple instances or requiring zero-downtime failover.
- The backend verifies tokens by calling Supabase on each request. This is
  correct for revocation, but adds latency and depends on Supabase availability.
  Add a short-lived verified-token cache only with a deliberate revocation
  trade-off and tests.
- Supabase Auth is the identity provider; the app does not yet provide account
  deletion, email change, MFA, or a support workflow for disputed claims.
- Knowledge notes and virtual-contest sessions remain browser-scoped in their
  storage format, though they are now moved into the active account scope.
  Cross-device sync for those formats is still a follow-up.
- Push subscriptions previously written under browser client ids do not match
  the new account ids. Users must re-enable notifications after signing in;
  old Cloudflare D1 delivery rows age out through the existing 180-day
  retention cleanup. Backend `push_subscriptions` rows are repointed during an
  audited legacy claim.
- The old status docs (`docs/development-status.md`,
  `docs/production-data-architecture.md`, and parts of `README.md`) contain
  historical descriptions of client-id auth and `/tmp` storage. Use this file
  for the current release state.