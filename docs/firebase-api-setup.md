# First Firebase API deployment: api.owlwatcher.tech

**Preparation only. These files do not deploy anything, change DNS/IAM, modify
Firestore, or update the GitHub Pages/Android frontend.**

The user has connected `api.owlwatcher.tech` to the `finder-owl` Hosting site and
shown Blaze billing enabled. Their CLI reported no deployed functions. Those are
user-observed facts, not an independent live check. The former API A record was
replaced with the CNAME Firebase requested. `Site Not Found` before the first
Hosting release is expected. Do not change the website (`@`, `www`, `app`) records.

## Scope: a read-only first release, NOT the full app

The initial cloud entry point always enables `firebase-read-only`, even if an
environment variable attempts to disable it. It exports **only `api`**, with no
Scheduler export and no process maintenance. There is no env toggle to release
private routes; that needs a reviewed authorization change.

Allowed GET/HEAD routes:

- `/api/health` — no database access, available during drain.
- `/api/quota` — last-known quota diagnostics, no database access.
- `/api/app-version` — public update policy.
- `/api/ads/global`, `/api/ads/local/{safe-id}`, `/api/ads/greeting/{safe-id}` —
  previously reviewed public ad content, not generic collection access.

All other routes and all mutations return `403` with
`code: "firebase-api-read-only"` before Monitoring, auth, body parsing or database
work. CORS may answer OPTIONS preflights, but that does not authorize a request.
The gate applies to the direct Function/Cloud Run URL too, not just Hosting.
Public application reads still require a successful quota check. Health/quota
returning 200 is **not** proof that Monitoring or Firestore permissions work.

**Do not point the existing website or Android app at this pilot as its primary
backend.** Login, vehicle search, premium codes (including validation), and all
writes deliberately do not work. See [the release-blocking authorization review](firebase-api-security-review.md).

## Architecture and files

```text
GitHub Pages / Android (unchanged for now)
  eventual base: https://api.owlwatcher.tech/api
                           |
Firebase Hosting: finder-owl, custom domain api.owlwatcher.tech
  /api and /api/** -> Function api, us-central1
                           |
Read-only release gate -> App Check / auth / quota layer -> Firestore
```

- `firebase.api.json`: separate, explicit API-only Hosting deployment. Static
  contents are only `firebase/api-public/index.html` and `404.html`.
- `firebase.json`: existing website Hosting configuration is left intact. Do not
  use it for the API-only deployment; it stages the website.
- `server/firebase.js`: same Functions source/codebase for both configs; only API
  is exported, safe even if the generic Functions command is used accidentally.
- `server/.env.firebase.example`: private configuration template; never publish
  the filled file or an Admin SDK key.
- `scripts/check-api-deploy.js`: local, non-network, read-only preflight. It does
  not prove that billing, IAM, DNS or live routes are correct.

The two configs intentionally address the same default `finder-owl` Hosting site.
A later deployment with the old website config would replace the API-only Hosting
release. Do not alternate them or use a broad `firebase deploy`. The API config
pins `us-central1`; changing region needs a coordinated rewrite/code review.

## 1. Update the MacBook folder and check locally

Use the reviewed/merged version of these changes. A ZIP folder does not update
itself. Preserve `.env.macbook` and credentials outside deployment folders; do
not overwrite them or assume the existing `Desktop/gor` is current.

Use Node.js 22 for project verification/deployment compatibility (the cloud
runtime is explicitly Node 22, even if the CLI can log in on Node 24).

```sh
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm audit
npm --prefix server audit --omit=dev
npm test
npm run check
npx firebase-tools login
npx firebase-tools projects:list
npx firebase-tools functions:list --project finder-owl
```

See [dependency refresh and install-script review](dependency-updates.md) for the
lockfile changes and validation. Do not use `npm audit fix --force` or approve
all dependency install scripts to silence warnings.

Inspect any preexisting function before proceeding. Do not accept deletion of
unrelated functions. No scheduled maintenance should exist for this initial
project; omitting a Scheduler export is not a way to disable a preexisting job.
If one exists, pause and arrange an explicit reviewed disable/delete operation.

## 2. Create a dedicated runtime service account (Google Cloud Console)

Select **finder-owl**, then IAM & Admin -> Service Accounts -> Create service
account. Use account ID **owl-api-readonly**. Its email should be:

`owl-api-readonly@finder-owl.iam.gserviceaccount.com`

Grant only the runtime permissions required by this pilot:

- **Cloud Datastore Viewer** (`roles/datastore.viewer`) for Firestore reads.
- **Monitoring Viewer** (`roles/monitoring.viewer`) for usage metrics.

Do not grant Owner, Editor, Datastore User (write access), or Firebase Admin to
this account. Do not create/download a JSON key. Functions uses its runtime
identity (ADC). Runtime IAM is separate from the deployer's permissions; the
CLI user needs permission to deploy Functions/Run/Hosting and to act as this
service account. If deployment reports a missing permission, address that exact
permission instead of granting broad project roles to the runtime.

Enable **Cloud Monitoring API** (`monitoring.googleapis.com`) in the API Library.
Functions v2 also needs Cloud Functions, Cloud Run, Cloud Build and Artifact
Registry APIs. The CLI may prompt to enable these; review the project and costs.
No Cloud Scheduler service/job is required by this API-only release.

Firestore IAM is an additional write barrier, not a replacement for the route
gate: Admin SDK reads bypass client Firestore rules, and Viewer can read private
collections if the application gate were removed. Future code spending gift
codes needs an explicitly reviewed write identity/policy, not a blanket IAM
upgrade for this pilot.

## 3. Create production settings privately

Do not copy `.env.macbook` or ADC credentials. If `server/.env` already exists,
back it up outside `server/` and inspect it privately before changing it. Do not
paste any secret here. Keep just one active `server/.env`; the preflight rejects
additional `server/.env.*` overrides (except example templates).

If `server/.env` does not exist, copy `server/.env.firebase.example` to it. Replace
its JWT placeholder with a newly generated secret of at least 32 random
characters. For example, generate it privately in your own Terminal:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Never share that output or a screenshot of the filled environment file. Runtime
functions don't issue JWTs in this pilot, but the shared app still requires a
secret at startup. This is a new cloud identity, not a rotation of the MacBook
secret. Do not reset existing account claims or gift codes.

Required configuration is provided in the template, including:

```dotenv
NODE_ENV=production
OWL_FIREBASE_PROJECT_ID=finder-owl
DATA_BACKEND=firestore
AUTH_MODE=firebase
APP_CHECK_MODE=monitor
SERVE_STATIC=0
ENABLE_CRON=0
QUOTA_ACTION=stop
QUOTA_SOURCE=monitoring
QUOTA_THRESHOLD=0.8
QUOTA_FALLBACK_URLS=
FUNCTIONS_REGION=us-central1
MAX_INSTANCES=2
CONCURRENCY=20
API_RUNTIME_SERVICE_ACCOUNT=owl-api-readonly@finder-owl.iam.gserviceaccount.com
ALLOWED_ORIGINS=https://prsd503.github.io,https://app.owlwatcher.tech,https://api.owlwatcher.tech,https://localhost,http://localhost,capacitor://localhost
```

This snippet deliberately omits JWT_SECRET; set it privately. Exact origins
include no `/gor` path. Confirm the actual Android WebView origin before future
client rollout; native HTTP without Origin is allowed by CORS but cannot bypass
the route gate. Do not add wildcard/ngrok origins. App Check monitor is tolerated
only for these public read-only routes, not as authorization. Enforce it once
all supported clients can attest. Never turn it off to fix a 401.

Do not set `ENV_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `SERVICE_ACCOUNT_JSON`,
local passwords or local database paths inside the cloud env file. No credential
JSON belongs under `server/`, even if renamed. Restrict permissions on the file
on your Mac (`chmod 600 server/.env`) and never commit it.

```sh
node scripts/check-api-deploy.js
```

If your Terminal exported ENV_FILE for local tests, use a separate shell or
`unset ENV_FILE` before deployment. The preflight also rejects exported variables
that conflict with the production env file, without printing their values. Fix
preflight errors; don't bypass the guard.

## 4. Deployment sequence — only after review and explicit approval

These commands are provided for the later supervised deployment. They have
**not** been run by this preparation. They publish real resources and can incur
costs even if application usage is low.

First deploy just the gated API:

```sh
npm run deploy:api:functions
```

This script selects `firebase.api.json`, project `finder-owl`, and
`--only functions:api`. Confirm the deployed runtime service account matches the
one above. Configure a short Artifact Registry cleanup policy when prompted;
builds and stored images have costs outside the application quota guard.

Test the direct Function before publishing Hosting:

```sh
curl -i https://us-central1-finder-owl.cloudfunctions.net/api/health
curl -i https://us-central1-finder-owl.cloudfunctions.net/api/ads/global
curl -i https://us-central1-finder-owl.cloudfunctions.net/api/quota
curl -i https://us-central1-finder-owl.cloudfunctions.net/api/vehicles
```

Expected: health 200 with `accessMode: firebase-read-only`; public ads 200 if the
quota/IAM checks succeed; vehicles 403. Inspect quota **after an application
read**: `source: monitoring`, `action: stop`, threshold .8, a fresh
`remoteCheckedAt`, and `monitoringUnavailable: false`. If Monitoring fails, fix
API/IAM permissions; never use local counters or disable stop mode to get 200.
The HTTP Function explicitly requests public invocation, because these gated
public reads must work without a Cloud Run IAM identity token. This is separate
from Firebase Auth for private application routes. If organization policy blocks
public invocation or the platform returns 403 before JSON health, review that
policy for this deliberately public, gated function only; do not grant broad
project access or remove the application gate.

Only after these pass, deploy API-only Hosting:

```sh
npm run deploy:api:hosting
```

Then repeat checks at `https://api.owlwatcher.tech/api/...`. Test the following
at both the direct Function URL and the custom domain:

| Request | Expected |
| --- | --- |
| GET health, quota | 200 diagnostics (not proof application work is healthy) |
| GET ads/global | 200, subject to quota and App Check mode |
| GET vehicles, admins, guards, notices/Test, societies, config | 403 read-only restriction |
| POST auth/token, gift-codes/validate, gift-codes/redeem, vehicles | 403, no DB mutations |
| PATCH societies/Test/active-guard | 403 even with any bearer token |
| Website/Android exact allowed Origin | corresponding CORS origin header |
| Unlisted/attacker ngrok Origin | rejected (including preflight) |
| Root of custom domain | small API status page, not the website |
| /server/index.js, /.env, /bouquet.html | Hosting 404, no repository files |

Do not test a real redeemable code against any non-pilot server as a probe. Do
not paste tokens/env files into screenshots. This prep makes **no frontend API
configuration change**, and does not build/release an Android binary. An eventual
full release can use the same permanent base for both frontends, with one-time
client updates after authorization and all route contracts have been verified.

## Billing, rollback, next work

The 80% guard covers configured Firestore read/write/delete counts and project
Cloud Run request/sent-byte proxies. It does **not** cap the invoice: compute,
static Hosting, storage, builds, images, logging, authentication/SMS and other
services can cost money; Monitoring is delayed and clients can bypass the API
by using Firestore directly. The per-instance request limiter is not a global
abuse/billing control. The free-trial credit and INR budget alert are not usage
limits. Monitor Cloud Billing separately.

No frontend is moved in this pilot, so leave current client configuration alone.
If a custom-domain request fails, use the direct Function URL only for controlled
troubleshooting; do not make it an automatic credential-receiving fallback.
Keep a record of current DNS/Hosting releases before changes. A Hosting rollback
only changes Hosting, not Function code, IAM, DNS or data; roll back only to a
known-safe API-only release. If the prior API was in use, DNS cutover may already
have interrupted those old clients—do not claim this pilot restores full service.
Never cancel old hosting until a separately authorized migration is complete.
