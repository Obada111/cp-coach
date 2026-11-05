# CP Coach development status

Audit snapshot: 2026-11-03

## Current state

CP Coach is a React 18/Vite/TypeScript frontend and an Express/TypeScript backend. The backend contains the existing Codeforces training, recommendations, reviews, weekly goals, journals, contests, and notifications features. The frontend is deployed as a static Vite app through the existing Vercel configuration.

The current data architecture is not yet a single durable production architecture:

- Training and profile state use native SQLite in `backend/src/db.ts`. Local development defaults to `backend/data/cp_coach.db`.
- Public mode uses SQLite under `/tmp/cp_coach` on Render Free and additionally saves learning state in each browser's local storage for backup/restore.
- The new social feature uses Supabase Auth and a separate PostgreSQL database through the backend.
- The optional Cloudflare notifications worker persists notification state in D1.

This separation currently supports guest training alongside authenticated social features, but it does not yet satisfy the goal of one durable application data store. Browser snapshots are useful backups, not a substitute for persistent server storage or cross-device synchronization.

The uncommitted Supabase social migration is additive and defines RLS policies for its social tables. It has not been applied or exercised against a database. There are no coaching-specific student, group, assignment, or feedback workflows in the inspected routes/schema yet. Existing tests cover parts of authentication, recommendations, backups, Codeforces, and social behavior, but the migration's RLS behavior still needs disposable staging integration tests.

## Machine and safety audit

- C: had approximately 8.5 GB free when checked; D: had approximately 301 GB free. This differs from the earlier estimate in the supplied project brief.
- Docker Desktop's Linux engine pipe was unavailable. Both `Ubuntu` and `docker-desktop` WSL distributions were stopped.
- No Docker images, containers, volumes, WSL data, personal files, databases, or application data were deleted or moved. Docker was not started.
- Tests ran with `backend/src/testSetup.ts` redirecting `DB_DIR` to a process-specific temporary directory. The live development SQLite database was not used by the test run.

## Work completed in this audit

- Read the existing architecture, auth and API entry points, SQLite initialization, social auth/database/routes, Supabase migration, deployment configuration, and test setup.
- Changed the rating chart in `frontend/src/App.tsx` to load lazily. The production entry chunk decreased from 707.33 KB (197.33 KB gzip) to 309.72 KB (86.58 KB gzip). The chart is now a separate 396.28 KB (109.19 KB gzip) chunk, while the social area remains separately lazy-loaded. This reduces the entry bundle; the chart chunk is still fetched when the chart is rendered.
- No database migration was applied and no hosting or paid resource was created.

## Verification

| Check | Result |
|---|---|
| Backend tests (`npm.cmd test`) | Passed: 18 files, 121 tests |
| Backend TypeScript build | Passed |
| Frontend TypeScript check and production build | Passed |
| Frontend bundle | Passed; no chunk-size warning after splitting the chart |
| Supabase migration / RLS integration | Not run; no staging database or working local Docker engine |
| Hosting/deployment smoke test | Not run; no staging deployment |

PowerShell blocked the `npm` alias because it resolved to `npm.ps1`; validation succeeded through `npm.cmd`.

## Production assessment and target

Do not treat the current Render Free deployment as production-ready. Render's official documentation says Free web services spin down after 15 minutes without traffic, take about a minute to spin back up, and lose local filesystem changes on restart, spin-down, or redeploy. Free services cannot attach persistent disks. The current `/tmp` SQLite database is therefore ephemeral despite the browser backup feature.

Recommended target: one Supabase-managed PostgreSQL database as the durable source of truth for training, journal/reviews, social, coaching, and notification state; retain SQLite only for local development until a tested migration and cutover are ready. Keep the existing Node API on an always-on paid service and the frontend on static hosting. Do not have the production API silently fall back to SQLite. The Cloudflare Worker can remain a scheduler/delivery integration, but durable application data should not be split between Postgres and D1.

This target requires a careful schema/data migration. First build a staging environment, export and validate existing learning data, apply reviewed migrations only to a disposable database, test ownership/RLS with separate accounts, and verify restore procedures. The current social migration is not a migration of existing SQLite learning data. Production cutover, DNS changes, resource creation, and applying migrations to any existing production project remain approval-gated.

### Hosting options and indicative cost

Official pricing and platform documentation checked on 2026-11-03:

- Render Free is unsuitable for durable data or an always-responsive API. Render lists Frankfurt among its service regions. Paid services can attach persistent disks, but disk-backed services are single-instance and redeploy with downtime. See [Render Free limitations](https://render.com/docs/free), [persistent disks](https://render.com/docs/disks), and [regions](https://render.com/docs/regions).
- Railway Hobby is $5/month and includes $5 of usage; service usage beyond that is billed by CPU, RAM, volume, and egress. Its currently documented European region is Amsterdam. A small always-on backend is approximately $10-$15/month under a 0.5 GB RAM and 0.25-0.5 vCPU assumption; measure real usage before choosing a service size. See [Railway pricing](https://railway.com/pricing) and [regions](https://docs.railway.com/deployments/regions).
- Supabase Pro starts at $25/month and includes a Micro compute credit for one project; paid projects are not paused for inactivity. Supabase documents Frankfurt as a region option. See [Supabase pricing](https://supabase.com/pricing) and [regions](https://supabase.com/docs/guides/platform/regions).
- Vercel Hobby is $0 for a personal project; Pro is listed at $20/month. Keep the frontend static and confirm the account/usage plan is eligible before relying on Hobby limits. See [Vercel pricing](https://vercel.com/pricing).
- Cloudflare Workers Free includes up to 100,000 requests per day and 10 ms CPU per invocation; the Paid plan starts at $5/month. The existing low-volume scheduled worker may fit Free limits, subject to end-to-end testing. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Indicative target baseline is approximately $35-$40/month before tax, egress, storage growth, and usage overages: Supabase Pro at $25, plus roughly $10-$15 for a small always-on Railway backend, with static Vercel hosting at $0 if Hobby is appropriate. This is a planning estimate, not a quote or authorization to create paid resources. A Render-based alternative should be priced in its dashboard before approval.

## Remaining work / blockers

1. Establish isolated staging services only after approval; use a staging-only Auth project, database, and secrets.
2. Design and test the full SQLite-to-PostgreSQL schema/data migration; review the existing social migration independently before applying it anywhere.
3. Add database-level ownership/RLS integration tests for social and future coaching tables, including cross-user read/write attempts.
4. Implement and test coaching accounts, groups, assignments, feedback, and sharing permissions before advertising coaching support.
5. Add production backup/restore drills, operational health checks, and staging deployment verification.
6. Confirm hosting region, plan eligibility, live provider quote, data-retention requirements, and a production cutover window before deployment.
