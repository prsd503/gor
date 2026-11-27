> **Current release status:** the live Firebase Function is still the prior
> read-only pilot. This branch now stages a full-feature API profile, but it has
> not been deployed and its write IAM/configuration is not in place. See
> [the full-release guide](firebase-api-full-release.md). The original
> [read-only pilot guide](firebase-api-setup.md) is archived; do not follow it
> for a full-feature release. Emulator validation and production prerequisites
> remain outstanding.

# Firebase backend and MacBook testing (replacing Hostinger)

## What is implemented

The existing Express API now runs either as a Firebase **second-generation Cloud Function** or as a long-running Node server on a MacBook. Hostinger is no longer the frontend's default API target. `api-env.js` is the one place to configure the deployed API and optional fallback.

- Cloud: `server/firebase.js` exports only the HTTP `api` function. The Firebase pilot disables cron and blocks private routes and all writes.
- MacBook: `npm run start:local` runs the backend with a local JSON database and dev login, **without initializing the Firebase Admin SDK**.
- Guard: application requests return HTTP **503** at/above 80% of a tracked allowance, before App Check, authentication or route database work. Health/quota diagnostics remain available. Scheduled maintenance also skips work while draining.
- Browser: `api-config.js` switches to a **preconfigured, trusted** fallback after an explicit drain. GET/HEAD also fail over on network errors or 502/503/504. Writes are **not** retried on ambiguous network/server errors, to avoid duplicate commits.

## Important: this is not a guaranteed $0 billing cap

**Cloud Functions cannot be deployed on Spark.** Firebase requires a billing-enabled **Blaze** project, which includes no-cost allowances. See [Firebase's official pricing FAQ](https://firebase.google.com/docs/functions/faq-and-troubleshooting) and [pricing](https://firebase.google.com/pricing).

The circuit breaker stops *application work*, not Google's function infrastructure. Even a rejected request invokes the function. Monitoring has sampling/ingestion delays; concurrent instances, in-flight operations, large collection reads, other services, and direct SDK clients can consume quota before a new usage check arrives. Per-instance counters are estimates, not distributed reservations. This is why an exact project-wide cutoff at precisely 80%, or a promise of no bill, would be misleading.

The guard tracks these default operating budgets (override with `QUOTA_*` variables if your project's allowance differs):

| Meter | Configured allowance | Stop at 80% | Window/source |
| --- | ---: | ---: | --- |
| Firestore document reads | 50,000 | 40,000 | Pacific calendar day, Monitoring |
| Firestore document writes | 20,000 | 16,000 | Pacific calendar day, Monitoring |
| Firestore document deletes | 20,000 | 16,000 | Pacific calendar day, Monitoring |
| Cloud Run / Functions v2 requests | 2,000,000 | 1,600,000 | UTC calendar month, Monitoring |
| Cloud Run sent bytes | 5 GB | 4 GB | UTC calendar month, Monitoring |

These are configured budgets, **not a discovery of billing entitlements**. Cloud Run sent bytes are a conservative network proxy, not geographically priced billable egress. All matching Cloud Run services in the project are counted. Firestore Monitoring document counts likewise need not exactly equal billed reads (for example, index-entry billing). Verify the region, billing account, database eligibility and current pricing before deploying. Shared allowances may be consumed by other projects on the same billing account.

**Not covered:** CPU/memory execution time, stored Firestore data, index/storage costs, Firestore network egress, Firebase Hosting bandwidth/storage, Auth/SMS, builds, Artifact Registry images, Scheduler, logging or other products. These can cost money independently of the five meters. The optional Hosting deployment has its own quotas; the API guard does not stop static Hosting.

Set billing alerts, restrict abuse, use a lower threshold if needed, and review provider-side spend controls. Alerts and `maxInstances` alone are not hard billing caps. If absolutely no billing account/no possible charges is required, use the MacBook path and a static host instead of Cloud Functions.

## 1. Test on the MacBook first

See [macbook-testing.md](macbook-testing.md). No Firebase account, key or CLI is needed for that path.

## 2. Deploy the API to Firebase

Requires Node **22**, npm, permission to deploy Functions v2, a Firestore database, and a Blaze project. The examples use the app's existing `finder-owl` project. Use a separate project for staging if possible.

```sh
npm ci
npm --prefix server ci
npx firebase-tools login
cp .firebaserc.example .firebaserc
# Edit .firebaserc if deploying a different project.
cp server/.env.firebase.example server/.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Edit **`server/.env`**, replacing `JWT_SECRET` with that generated value. Never deploy the local-development environment example. In production:

```dotenv
NODE_ENV=production
OWL_FIREBASE_PROJECT_ID=finder-owl
DATA_BACKEND=firestore
AUTH_MODE=firebase
APP_CHECK_MODE=monitor
SERVE_STATIC=0
QUOTA_ACTION=stop
QUOTA_SOURCE=monitoring
QUOTA_THRESHOLD=0.8
QUOTA_FALLBACK_URLS=
ALLOWED_ORIGINS=https://finder-owl.web.app,https://finder-owl.firebaseapp.com
```

- `JWT_SECRET` must be at least 32 random characters. Use the same secret on an intentionally compatible fallback if it must accept existing backend JWTs.
- `APP_CHECK_MODE=monitor` preserves rollout compatibility. Switch to `enforce` once clients send valid tokens; see [app-check.md](app-check.md). Do not weaken Auth/App Check on an Internet-facing fallback.
- Add the actual frontend/custom-domain origins to `ALLOWED_ORIGINS`.
- Default region is `us-central1`, with zero minimum instances. The production example limits scaling to two instances. Region affects pricing and latency; if changed, update `api-env.js` to match.
- `OWL_FIREBASE_PROJECT_ID` avoids the Firebase CLI's reserved `FIREBASE_*` dotenv prefix. On Cloud Functions the runtime project is also autodetected.
- Cloud Functions uses its runtime service account (ADC). **Do not upload a service-account private key.** Never set `DATA_BACKEND=local` on Functions: its filesystem is ephemeral and not shared.

### Monitoring access is required

Enable `monitoring.googleapis.com` in the project's Google Cloud API Library. Grant **Monitoring Viewer (`roles/monitoring.viewer`)** to the actual runtime service account of the **API function** in IAM. Functions v2 normally uses the Compute Engine default service account, not necessarily `PROJECT@appspot.gserviceaccount.com`. Check the deployed function's Runtime settings instead of guessing the email.

If using Google Cloud CLI, the command format is:

```sh
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:ACTUAL_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  --role="roles/monitoring.viewer"
```

The initial runtime needs read-only Firestore access (`roles/datastore.viewer`), not write privileges. It also requires `API_RUNTIME_SERVICE_ACCOUNT` in `server/.env`; see the API-only guide. The deployer needs normal Firebase/Cloud Run deployment permissions. The Firebase CLI will identify missing APIs/permissions during deployment.

```sh
npm run deploy:full
```

The deployment exports only the `api` Function; there is **no scheduled Function** and no process cron. Maintenance jobs (the midnight IST notice rollover and the 7-day expired-booking cleanup) run on demand from the master admin portal via `POST /api/maintenance/notices` and `POST /api/maintenance/bookings`. A dedicated runtime service account and exact allowed origins are required; follow the linked API-only guide before deployment. Image/build/storage costs remain outside the guard.

**When Monitoring fails or permissions are missing, stop mode fails closed:** the API returns a drain response with `code: "quota-monitoring-unavailable"`, rather than trusting one new instance's zero counters. On cold start, the first protected request waits for the check. Checks are shared within an instance for `QUOTA_REFRESH_MS` (default 60 seconds), not across instances. Do not switch production to `QUOTA_SOURCE=local` to bypass a permissions problem.

Verify after deployment:

```sh
curl https://api.owlwatcher.tech/api/health
curl https://api.owlwatcher.tech/api/quota
npm run quota:status -- https://api.owlwatcher.tech/api
```

The HTTP function accepts `/config` under its function URL as well as `/api/config` on its generated Cloud Run URL. When using the latter, set the API base to `https://YOUR_SERVICE.run.app/api`.

`/quota` diagnostics do not themselves fetch fresh Monitoring data; an application request or maintenance run refreshes it. Check `remoteCheckedAt`, `monitoringUnavailable`, `source`, `action`, and `metrics`, not just `/health` returning 200.

## 3. Future full-release frontend configuration (NOT the read-only pilot)

Only after the authorization release blockers are fixed and the full API is verified, edit `api-env.js`. Do **not** move current clients to the read-only pilot:

```js
window.OWL_API_CONFIG = {
    primary: 'https://api.owlwatcher.tech/api',
    local: '',
    fallbacks: []
};
```

All application pages load it before API calls. Existing Auth and App Check behavior is retained. The version popup does not bypass the managed API's drain by making a direct Firestore read.

Keep GitHub Pages for the website. **Firebase Hosting is not deployed at all** (the former API-only Hosting site and its stub pages were removed, along with `firebase.api.json` and `scripts/prepare-hosting.js`): the static frontend stays on GitHub Pages / the Android app, and the API is reachable through the **`api` Function's custom domain `https://api.owlwatcher.tech/api`** (Functions console → `api` → Custom domains; CNAME `api` → `ow-fc-apps-as-dns.google.com` at the DNS provider). That domain is the permanent frontend contract — `api-env.js` is fixed to it, so moving the backend to another cloud later only means remapping the domain. No automatic failover is configured (the app is pre-production and has no users relying on a fallback path); the Firebase Function URL remains a valid direct endpoint for CLI checks and debugging.

Hostinger is not an authorized backend host; do not direct backend traffic there. This code does not cancel a Hostinger plan or change DNS, and those cleanup actions require separate approval.

## 4. Optional MacBook fallback

For **testing**, run the MacBook server and set `local` in `api-env.js` and `QUOTA_FALLBACK_URLS` in the Firebase environment to its trusted HTTPS tunnel URL, e.g. `https://YOUR_TUNNEL_HOST/api`. Redeploy frontend/functions after changes. The browser deliberately does not trust arbitrary redirect URLs from query strings or response bodies: every credential-receiving base must already be in `api-env.js`.

An HTTPS page cannot reliably call `http://localhost:3000` on someone else's computer. Use a reachable HTTPS reverse tunnel, allow the website origin on the local server, and keep the MacBook awake. Your dev login must **not** be exposed publicly; use a private test tunnel/access policy, or run `AUTH_MODE=firebase` with the normal protections for a genuinely shared server.

**Local JSON data is independent of Firestore. There is no automatic replication or reconciliation.** An initially empty MacBook database does not contain production societies, bookings or gift codes. Local writes do not get uploaded when the browser returns to Firebase. Copying live redeemable codes to two independent stores risks double redemption. Therefore the JSON fallback is suitable for testing/isolated data, not a transparent high-availability production replica. Leave `local` empty if this is not acceptable; the app will surface 503 instead of silently changing data stores.

Running the MacBook against the **same Firestore** (`npm run start:firebase`) preserves shared data, but still consumes the same Firebase allowance, so it is **not** a quota escape hatch.

### Drain response and browser behavior

At the threshold:

```json
{"code":"quota-threshold-reached","fallback":["https://YOUR_TUNNEL_HOST/api"],"retryAfterSeconds":3600}
```

The response is HTTP 503 with `X-Owl-Drain: 1`, `Retry-After: 3600` and CORS-exposed diagnostic headers. The frontend uses its configured trusted fallback list, honors the cooldown, and periodically tries the primary again. Daily counters roll at Pacific midnight; monthly counters use UTC month boundaries. If all bases fail, the error/503 is surfaced. Browser failover is per client, not a global DNS/function shutdown. Calls outside this frontend are not redirected automatically.

`QUOTA_ACTION=monitor` logs/reports usage without blocking; `off` disables blocking. Neither protects the allowance. Local development defaults to `off` because it uses no Firebase data services.

## Verification

```sh
npm test
npm run check
```

The tests cover threshold edges, reset windows, fail-closed monitoring, cold-start checks, failover, safe write retries, auth/CRUD through the real local Express app, local transaction rollback, read-cache invalidation, maintenance and static-file isolation. A real Firebase deployment/billing check still requires your project; automated tests use mocked Monitoring responses and never consume production Firestore quota.
