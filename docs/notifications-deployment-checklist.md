# Notification setup and deployment checklist

This checklist covers the current Cloudflare D1 + Worker notification service, Render backend, and Vercel frontend. It does not migrate application data, create resources, or authorize a production deployment.

## Production architecture status

- **Durable Persistence (.00/mo)**: Render Free runs with ALLOW_EPHEMERAL_DB_CACHE=true and /tmp/cp_coach. User training context is automatically backed up to Supabase Free PostgreSQL (user_training_contexts table) and auto-hydrated on container cold-starts. No paid disk needed.
- **Authentication & Multi-User Isolation**: Training API endpoints verify Supabase JWTs (
equireAuthUser). Each user's data is strictly isolated by their authenticated owner_id. Legacy profiles can be claimed via the Account & Security panel.
- **Strict .00 Budget**: Zero-cost tier across Render Free, Supabase Free, Cloudflare Free, and Vercel Hobby.

## What is required for delivery

The backend reports notifications ready only when all of these are true:

- `PUBLIC_MODE=true`
- Backend `CLOUDFLARE_NOTIFICATIONS_URL`, `CLOUDFLARE_NOTIFICATIONS_API_SECRET`, and `VAPID_PUBLIC_KEY` are configured.
- The Worker is reachable using the shared API secret.
- Its `DB` binding can read the schema, including `contest_reminder_offsets`.
- The Worker has `API_SECRET`, `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY`.
- Backend and Worker VAPID public keys match.
- The Worker has completed a successful scheduled run within the last 15 minutes.
- The browser supports service workers and Web Push, has granted notification permission, and has a subscription registered with the backend.

The UI reports the browser permission, service worker, subscription, D1/schema, VAPID match, Worker health, last successful run, and the number of push-service-accepted deliveries separately. A registered subscription is not treated as enabled when its delivery prerequisites are unhealthy.

## Local development

Local-only files are intentionally ignored by Git:

- `backend/.env`
- `frontend/.env.local`
- `cloudflare/notifications-worker/.dev.vars`

They must not be copied into source control. The local backend database uses an isolated notification-test directory, not the existing application database. The local Wrangler D1 migration ledger is current.

From the repository root in PowerShell:

```powershell
npm.cmd --prefix cloudflare/notifications-worker run db:local
npm.cmd --prefix cloudflare/notifications-worker run dev -- --ip 127.0.0.1 --port 8787
npm.cmd --prefix backend run dev
npm.cmd --prefix frontend run dev -- --host 127.0.0.1 --port 5173
```

Vite development mode does not register `/sw.js`; use the production preview when testing Web Push:

```powershell
npm.cmd run build
npm.cmd --prefix frontend run preview -- --host 127.0.0.1 --port 4173
```

Open the preview on `http://127.0.0.1:4173`, complete the normal browser onboarding, and enable notifications from Settings. The local Worker cron is not automatic under Wrangler; trigger one run with:

```powershell
curl.exe "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

Only use `--local` for local D1 checks. Do not pass `--remote` during local setup.

## Production prerequisites (manual; do not run without deployment approval)

### 1. Create and bind D1

From `cloudflare/notifications-worker`:

```powershell
npx wrangler d1 create cp-coach-notifications
```

Copy the returned database ID into `d1_databases[0].database_id` in `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`. Preserve the existing `DB` binding and `migrations_dir: "migrations"`. Confirm the selected Cloudflare account and region before proceeding.

Back up the target database using the Cloudflare dashboard's supported D1 backup/PITR procedure before the first schema change. Then apply and verify the migrations:

```powershell
npx wrangler d1 migrations apply cp-coach-notifications --remote
npx wrangler d1 migrations list cp-coach-notifications --remote
```

This applies `0001_notification_schema.sql` and `0002_contest_reminder_offsets.sql`. Do not use `wrangler d1 execute --remote` as a substitute for the migration ledger.

### 2. Generate production secrets and configure Worker secrets

Generate a **new production** VAPID pair; do not reuse the local test pair:

```powershell
node -e "console.log(JSON.stringify(require('./backend/node_modules/web-push').generateVAPIDKeys(), null, 2))"
```

Keep the output in a password manager or another approved secret store. From `cloudflare/notifications-worker`, set each value through Wrangler's interactive secret prompt:

```powershell
npx wrangler secret put API_SECRET
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

Generate a separate high-entropy shared API secret and enter **the same value** for Worker `API_SECRET` and backend `CLOUDFLARE_NOTIFICATIONS_API_SECRET`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`VAPID_SUBJECT` is the non-secret Worker variable already declared in `wrangler.jsonc`. Never put `VAPID_PRIVATE_KEY` in Render, Vercel, frontend variables, or Git.

### 3. Deploy the Worker, then verify it

After confirming the production account, database ID, migration status, and secret values:

```powershell
npx wrangler deploy
```

The deployment uses the existing `DB` D1 binding and installs the `* * * * *` cron trigger. Each invocation evaluates at most twenty tasks and sends at most ten pushes; due contest reminders take priority over daily reminders because contest reminders have a short delivery window. Nominal capacity is 50 pushes in five minutes if each scheduled invocation completes, but this is not a delivery-time guarantee: a queue can still exceed capacity or the configured Free-plan 10 ms CPU ceiling. Measure production Cron CPU before increasing the batch or moving to a paid plan. Cloudflare Workers Paid currently starts at $5/month; no plan change is authorized here.

Verify the deployed Worker before changing backend settings:

```powershell
curl.exe "https://<worker-name>.<account-subdomain>.workers.dev/health"
```

Expect `storageReady: true`, `vapidConfigured: true`, and a matching public VAPID key. `schedulerHealthy` remains false until the first successful scheduled run; wait for the cron or a separately approved manual trigger before enabling clients.

### 4. Configure Render backend variables

The current [`render.yaml`](../render.yaml) declares the server environment. Configure its `sync: false` values in Render's **Environment** UI; keep secrets server-side:

```text
NODE_ENV=production
PUBLIC_MODE=true
HOST=0.0.0.0
CLOUDFLARE_NOTIFICATIONS_URL=https://<worker-name>.<account-subdomain>.workers.dev
CLOUDFLARE_NOTIFICATIONS_API_SECRET=<same value entered for Worker API_SECRET>
VAPID_PUBLIC_KEY=<same public key entered for Worker VAPID_PUBLIC_KEY>
DATABASE_URL=<approved-Supabase-Postgres-connection-string>
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<Supabase-anon-key>
CODEFORCES_CREDENTIAL_ENCRYPTION_KEY=<base64-encoded-32-byte-secret>
CORS_ORIGINS=https://<production-vercel-domain>
```

Render provides `PORT`; do not hard-code it. Notification subscriptions, preferences, delivery history, and retry state live in D1, not backend SQLite. The current blueprint explicitly points SQLite to `/tmp/cp_coach` on a free instance and has no persistent disk; changing `DB_DIR` alone does not make storage durable. Do not deploy this configuration for durable user training data.

Only after the storage and ownership blockers above are resolved, restart the Render service after the Worker health check succeeds. Then open Notifications settings and verify every readiness row, including a recent successful scheduled run.

### 5. Configure Vercel

The current [`vercel.json`](../vercel.json) builds `frontend/` as a Vite static site. Configure these production build variables in the Vercel project:

```text
VITE_PUBLIC_MODE=true
VITE_API_BASE_URL=https://<render-service-domain>
```

These are frontend build variables, not secrets. If Supabase sign-in is enabled in the frontend, also set the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Do not set `CLOUDFLARE_NOTIFICATIONS_API_SECRET`, `API_SECRET`, or either VAPID private key in Vercel. Build and deploy the frontend only after the backend health/readiness check is successful.

## Deployment order and smoke tests

1. Confirm backups and the target Cloudflare account/database.
2. Create D1, set its ID in Wrangler configuration, apply and verify both remote migrations.
3. Configure Worker secrets and deploy the Worker.
4. Verify Worker `/health`; wait until `schedulerHealthy` is true.
5. Configure Render variables and deploy the backend only after resolving durable storage and training ownership.
6. Verify backend `/health`, then inspect Notifications readiness in the application.
7. Deploy the Vercel frontend with only public build variables.
8. On a supported browser, grant permission, subscribe, enable a reminder offset, and verify that the subscription and preference are persisted.
9. Schedule a controlled contest fixture, verify one push, then rerun the Worker and confirm no duplicate. Verify that a failed push is retried and an expired subscription is removed.
10. Repeat for 24 hours, 1 hour, 30 minutes, and 5 minutes; verify updated/cancelled contests, past-contest exclusion, Hebron DST dates, and delivery while the app is closed.

Do not use production test pushes or test fixtures without a separate approval. The scheduler runs every minute with a ten-push-per-run cap; monitor queue lag and Cloudflare CPU/runtime limits before relying on it for a larger audience.

## Validation commands

From the repository root:

```powershell
npm.cmd --prefix backend test
npm.cmd --prefix cloudflare/notifications-worker test
npm.cmd --prefix cloudflare/notifications-worker run typecheck
npm.cmd run build
```

These commands validate code and local test resources only; they do not apply remote migrations or deploy.

## Current verification and limitations

- Local D1 migrations `0001` and `0002` are applied; no remote D1 operation was performed.
- Local Worker/backend configuration is isolated and ignored by Git. VAPID public/private pairing and the backend/Worker shared values were checked without printing the secret values.
- A real Edge Web Push subscription was registered and persisted in local D1. A Worker-scheduled local contest reminder was accepted by the push service and observed as a notification created by the browser service worker.
- Automated tests cover retry, duplicate prevention, all four offsets, rescheduling/cancellation, and Hebron DST behavior. They do not prove provider delivery under production load.
- Delivery with the entire browser process closed was attempted but could not be conclusively verified in this environment; the isolated browser's permission grant was temporary. Do not claim browser-closed delivery is verified until a supported browser with a persistent user-granted permission is tested.
- Production deployment, remote migrations, production secrets, and production push delivery remain unverified and require explicit approval.
