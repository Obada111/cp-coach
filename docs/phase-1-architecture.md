# Phase 1 architecture: Friends, Blogs, and notifications

## Architecture

- Guest mode continues to use the current browser-local training data and public training API. No guest client ID or Codeforces handle is promoted to an account identity.
- Social pages are lazy-loaded and are the only frontend entry point that initializes Supabase Auth or calls `/api/social`.
- Email OTP / magic links use Supabase Auth. The Express backend verifies each social request's bearer JWT with Supabase Auth's `GET /auth/v1/user`; the verified immutable `auth.users.id` is the only social owner ID.
- The backend uses a small `pg` connection pool to Supabase's transaction pooler. Each request starts a transaction, assumes the `authenticated` database role, sets claims from the already-verified JWT, and relies on PostgreSQL RLS in addition to owner-scoped query predicates. No service-role key is used.
- Codeforces handles are linked only after a short-lived random challenge is read back from `user.info.firstName`. The API documents `firstName` as a possibly absent field. The user manually restores their original profile field after verification; CP Coach never changes a Codeforces profile.
- Codeforces API Key and Secret are encrypted together with AES-256-GCM. The random 96-bit nonce and 128-bit authentication tag are stored separately; the master key exists only in Render secrets. Signatures are generated only on the backend.
- The signed `user.friends` test confirms that the submitted API key and secret work, but Codeforces does not return the API-key owner's handle from this method. The UI instructs users to submit credentials created for their already-verified handle; the backend does not claim cryptographic proof that the key belongs to that handle.
- A single backend Codeforces request queue coordinates dashboard synchronization, contest lookups, and Phase 1 requests. Social results are cached in PostgreSQL and refreshed by a background worker; no social API call is part of dashboard loading.
- In-app social notifications are durable rows with unique event keys. Browser push remains an optional, separately configured capability and is not reported as available until the existing VAPID + durable notification-worker path is configured and tested.

## Additive database schema

`supabase/migrations/202611020001_phase1_social.sql` adds only Phase 1 tables:

- `social_profiles`: Auth user, verified Codeforces handle, friend-request opt-in, presence privacy, and notification preferences.
- `codeforces_link_challenges`: per-user hashed, expiring ownership challenge.
- `codeforces_credentials`: encrypted credential envelope; no plaintext credential columns.
- `codeforces_friends_cache`: per-owner online state, rating, and last-known online time.
- `friend_requests` and `friendships`: directed request lifecycle and one canonical, undirected accepted relationship.
- `friend_presence`: expiring heartbeats, visible only to accepted friends when the user permits it.
- `blog_watchlist`, `blog_entries`, `blog_entry_comments`, and `blog_entry_state`: followed bloggers, per-user synchronized entry/detail cache, comments, read/saved state, and notes.
- `social_sync_state`: per-user background refresh watermarks.
- `social_notifications`: deduplicated in-app notifications.

Every user-owned table has RLS enabled. Policies use `auth.uid()`; friend-visible profile/presence reads are limited to accepted friendships and the owner's visibility settings. No existing SQLite or Supabase data is migrated or deleted.

## Required configuration

| Exact variable | Where | Classification | Value / how to obtain |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Vercel Preview for staging; Production only after approval | Public | Supabase project URL from the project's Connect panel, normally `https://<project-ref>.supabase.co`. |
| `VITE_SUPABASE_ANON_KEY` | Vercel, same environment scope | Public | Supabase publishable key or legacy `anon` key. Never use `service_role` or a secret key. |
| `VITE_API_BASE_URL` | Vercel Preview for staging | Public | Dedicated staging backend origin, e.g. `https://<staging-service>.onrender.com`, without `/api`. Leave production scope unchanged. |
| `SUPABASE_URL` | Staging Render service | Public configuration | Same staging project URL; backend calls its `/auth/v1/user` endpoint. |
| `SUPABASE_ANON_KEY` | Staging Render service | Public key stored as service configuration | Same publishable/anon key as the Vercel staging value. It is not a service-role credential. |
| `DATABASE_URL` | Staging Render secret | Secret | Supabase Connect panel → Transaction pooler. Use its host, port `6543`, database and pooler credentials; do not use the direct or session-pooler URL. |
| `CODEFORCES_CREDENTIAL_ENCRYPTION_KEY` | Staging Render secret | Secret | A unique staging-only 32-byte cryptographic random key, base64-encoded. Generate locally with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"` and place it directly into the protected Render secret field. Never paste it into chat, source, Vercel, or logs. Back it up in an approved secrets vault. |
| `CORS_ORIGINS` | Staging Render service | Public configuration | Exact staging frontend origin only (scheme + host, no path), e.g. `https://<staging-frontend>.vercel.app`. |
| `ALLOW_VERCEL_PREVIEWS` | Staging Render service | Public configuration | `false` for a fixed staging URL. Enable only if preview URLs are intentionally needed and separately controlled. |
| `PUBLIC_MODE` | Staging Render service | Public configuration | `true` for the public/browser-local dashboard. Keep staging `DB_DIR` isolated from production. |
| `CODEFORCES_REQUEST_TIMEOUT_MS` | Staging Render service (optional) | Public configuration | Optional milliseconds; defaults to `10000`. |

PostgreSQL pool settings are code constants, not environment variables: max 5 connections, 10-second idle timeout, 5-second connect timeout, keepalive, and TLS certificate verification. The backend wraps each social query in an explicit transaction, performs `SET LOCAL ROLE authenticated`, and sets transaction-local JWT claims. This is designed for transaction pooling, but must be verified against the actual staging pooler before enabling the app.

There are **no Codeforces key/secret environment variables**. Each test user enters their own API Key and Secret in Friends & Blogs; the backend signs calls and encrypts credentials using its Render-only master key. Use separate staging Codeforces accounts/keys, not production credentials.

Keep the existing production settings (`CORS_ORIGINS`, `ALLOW_VERCEL_PREVIEWS`, `PUBLIC_MODE`, cache TTLs and `DB_DIR`) unchanged while creating staging.

### Optional Cloudflare browser push

The existing Worker lives in `cloudflare/notifications-worker` and requires its own persistent D1 database and scheduled trigger. To enable it:

1. Create a separate staging Cloudflare D1 database named `cp-coach-notifications`; set its identifier in the staging copy of `wrangler.jsonc`, then apply `migrations/0001_notification_schema.sql` remotely with `npx wrangler d1 migrations apply cp-coach-notifications --remote`.
2. Generate a staging VAPID key pair. Set Worker variable `VAPID_PUBLIC_KEY` and the matching Render variable `VAPID_PUBLIC_KEY`; store `VAPID_PRIVATE_KEY` only as a Cloudflare Worker secret. Set `VAPID_SUBJECT` to a valid contact URI, such as `mailto:admin@example.com`.
3. Generate an independent staging shared secret. Store it as Worker secret `API_SECRET` and as Render secret `CLOUDFLARE_NOTIFICATIONS_API_SECRET`. Set Render `CLOUDFLARE_NOTIFICATIONS_URL` to the deployed staging Worker origin.
4. Deploy the Worker from `cloudflare/notifications-worker`. Confirm `/health` reports D1 readiness and `vapidConfigured: true`, then test a browser subscription and actual delivery end to end.

The Worker cron runs every five minutes. Until the D1 database, matching VAPID keys, shared backend secret, deployed Worker, and end-to-end delivery are verified, browser push must remain described as unavailable. In-app social notifications use Supabase and do not depend on this optional setup.

For push, `VAPID_PUBLIC_KEY` is public and must match between Worker and Render; `VAPID_PRIVATE_KEY` and `API_SECRET` are secrets stored only in Cloudflare Worker secrets. `CLOUDFLARE_NOTIFICATIONS_URL` is public configuration. `CLOUDFLARE_NOTIFICATIONS_API_SECRET` is a Render secret matching the Worker `API_SECRET`. Render does not need the VAPID private key.

Never set a Supabase `service_role` key in either frontend or Render for this design. Do not expose `DATABASE_URL` or the encryption key through any `VITE_` variable.

## Manual Supabase and Render setup

1. Create a new staging Supabase project with Auth and Managed PostgreSQL; do not reuse production. Select a region/plan approved for staging and check billing before provisioning.
2. In Authentication → URL Configuration, set the staging frontend as the staging Site URL. Add its exact origin to Additional Redirect URLs. Add `http://localhost:5173` only if local browser testing is needed. The frontend sets `emailRedirectTo` to `window.location.origin` and uses PKCE.
3. Enable email OTP/Magic Link. The backend checks each bearer token by calling that staging project's Auth `/auth/v1/user`. Google is not needed.
4. Configure the transaction pooler and test connectivity using the staging `DATABASE_URL`. Apply the reviewed SQL migration once to the empty staging project through SQL Editor or a linked Supabase CLI workflow. Do not execute it against production.
5. Before app access, verify RLS is enabled on all 14 created tables. Test with two separate accounts through the staging app/API—not a privileged SQL Editor connection—that neither user can read or mutate the other's credentials, friend requests, profile, presence, watchlist, entries, state, or notifications.
6. Create a dedicated staging Render service and Vercel Preview deployment; configure only staging-scoped values from the table above. Keep the staging backend to one instance because the Codeforces request limiter is process-local.
7. Test a staging backend restart and verify social rows remain in Supabase. Confirm guest training works independently and social routes fail closed when staging Auth/database/encryption configuration is absent.
8. Configure backups according to the staging plan; perform restore tests only in disposable non-production projects. Keep browser-push controls unavailable until Cloudflare is separately configured and end-to-end delivery is verified.

## Migration and rollback

- Apply the single additive migration first; it does not touch the existing SQLite database or guest browser data.
- Deploy backend code with social routes disabled/unavailable until `DATABASE_URL`, Supabase Auth, and the encryption key are present; core guest routes remain independent.
- Verify OTP, JWT rejection, RLS ownership, credential encryption, and cross-user isolation in staging before enabling the social navigation in production.
- Roll back application code by disabling the social navigation/routes. Keep the additive tables and data in place; do not drop tables during an application rollback.
- A schema rollback is a separate, explicitly approved operation: export the social tables, verify the export, then drop only Phase 1 tables in reverse dependency order. Never reset the Supabase project or migrate/delete existing SQLite data.

## Performance and operational limits

- Initial dashboard loading adds no Supabase, Friends, Blogs, or social notification requests. The social JavaScript chunk and all social API traffic begin only after opening the Friends & Blogs page.
- In the current UI, the `SocialHub` component is dynamically imported and only rendered when the Friends tab is selected. Validate network requests in staging with DevTools: capture navigation to dashboard ready, then enter Friends, Blogs, and switch between social sections; record request count and timing for each phase. No staging measurements are available until a staging deployment exists.
- Auth validation and PostgreSQL pool acquisition happen only on social requests. The Render pool is capped at five connections and configured for transaction pooling.
- External Codeforces work is serialized and in-flight deduplicated within each backend process at a minimum two-second spacing, cached in PostgreSQL, and scheduled outside dashboard requests. This deployment must remain a single Render instance unless the queue is moved to a distributed rate limiter; separate process-local queues do not enforce a global Codeforces limit. `user.blogEntries` accepts only one handle, so it is used only when a blogger is explicitly followed; periodic blog updates use one `recentActions` call and filter to followed handles. Article detail and comments are fetched only on explicit preview/open actions.
- Presence heartbeats are sent only while the social page is visible; the browser stops them when hidden or unmounted. Server expiry is authoritative.
- The existing training recommendation path and guest-mode browser backups are unchanged.

## Codeforces API verification

The official Codeforces API methods documentation lists `user.friends` (`onlyOnline`), `user.blogEntries`, `recentActions`, `blogEntry.view`, and `blogEntry.comments`. `user.blogEntries` accepts one handle per call; `recentActions` accepts up to 100 global recent actions, which makes it the appropriate bounded polling source. The official `User` object documents `firstName` as an optional field returned by `user.info`; the ownership flow verifies the challenge by reading this field back and does not treat an entered handle or API key as proof. Codeforces documents a maximum of one API request every two seconds; the shared queue uses that exact minimum interval.

References: [Codeforces API methods](https://codeforces.com/apiHelp/methods) and [Codeforces API objects](https://codeforces.com/apiHelp/objects#User).
