# Full-feature Firebase website and API release

## Current status

This branch now stages a **full-feature HTTP API profile** at the user's request. It removes the former global read-only gate while preserving route-level Firebase authentication, active staff membership checks, canonical society scoping, request validation, rate limits, App Check, exact production CORS origins, and the quota stop guard.

**It has not been deployed.** The live Function remains the earlier read-only pilot. No IAM, Firestore Rules, Hosting, Function, or production data was changed. The official Firestore Emulator test still has not run, and the sandbox currently lacks both `server/.env` and Firebase CLI authentication. The local deploy preflight therefore fails closed.

## What is enabled by this code profile

- Firebase ID-token exchange for verified identities.
- Admin and guard API login/profile flows, subject to active Firestore membership records and verified email.
- Admin/guard operations scoped to canonical society membership; master-only operations stay master-only.
- Public gift-code validation and one-time redemption; gift-code minting requires a master administrator.
- The other implemented API handlers, protected by their route-level authorization and input checks.

The old Firestore Rules do not grant these API permissions: the Admin SDK bypasses Firestore Rules. The Function runtime identity needs reviewed Firestore write permissions for mutations. Keeping old client Rules is a separate choice and does not make an API write succeed.

`ENABLE_CRON=0` disables in-process cron. A separate `noticeRollover` scheduled Function runs daily at 12:00 **am (midnight)** Asia/Kolkata, shifts each society’s tomorrow message to today, and clears tomorrow. It respects the quota guard; GETs compute the effective notice without writing if a run is delayed. Missed days do not revive an outdated tomorrow notice. Cloud Scheduler may incur charges and requires its API to be enabled.

## Correct deployment target

The **main website plus API Function** uses `firebase.json`:

- Hosting stages the explicit website allowlist into `.firebase-public`.
- Hosting rewrites `/api` and `/api/**` to `functions:api` in `us-central1`, so both the hosted website (`finder-owl.web.app`, `finder-owl.firebaseapp.com`) and the custom domain (`api.owlwatcher.tech/api/...`) work together.
- Functions deploys `server/firebase.js` as `functions:api` and `functions:noticeRollover` in `us-central1`.
- The website's `api-env.js` points to the Function URL (`https://us-central1-finder-owl.cloudfunctions.net/api`), and `server/.env.firebase.example` includes `https://finder-owl.web.app` and `https://finder-owl.firebaseapp.com` in `ALLOWED_ORIGINS` so browser calls from Firebase Hosting pass CORS.
- The config has no Firestore Rules section. `deploy:full` selects only `functions:api,functions:noticeRollover,hosting`.

`firebase.api.json` is an API-only Hosting site with small landing/404 pages; it is not the full website.

## Step-by-step setup from the beginning

1. **Google Cloud account & APIs (`finder-owl`)**
   - Resolve any Google Cloud account verification banner in Cloud Console so services are not suspended.
   - Confirm Blaze billing is active and **Cloud Monitoring API** (`monitoring.googleapis.com`) is enabled.
   - Ensure Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Cloud Firestore, and Firebase Authentication are enabled (Firebase CLI will also prompt if any Functions v2 API is missing).
2. **Create a dedicated runtime service account (IAM & Admin -> Service Accounts)**
   - Create `owl-api-runtime` (`owl-api-runtime@finder-owl.iam.gserviceaccount.com`). The old `owl-api-readonly` account is **Datastore Viewer** only and cannot perform Firestore writes; the preflight rejects read-only account names.
   - Grant minimum required roles: **Cloud Datastore User** (`roles/datastore.user`) for Firestore reads/writes and **Monitoring Viewer** (`roles/monitoring.viewer`) for the 80% quota guard. Do not grant Owner or Editor, and do **not** download a JSON key (Functions v2 uses ADC).
   - Ensure your deployer user can act as `owl-api-runtime@finder-owl.iam.gserviceaccount.com` (`roles/iam.serviceAccountUser` on that service account if deployment reports a permission error).
3. **Verify Firestore membership & society data**
   - Confirm `admins` and `guards` records have verified emails (and matching `uid` if stored), are active/not disabled, and reference canonical `/societies/{societyId}` documents (or `name` / `legacyNames` / `aliases`).
   - Confirm `admins.isMaster` is set only on true master administrators.
4. **Prepare the local project on Node 22**
   ```sh
   node -v                                   # use Node 22
   npm ci --ignore-scripts
   npm --prefix server ci --ignore-scripts
   cp .firebaserc.example .firebaserc
   cp server/.env.firebase.example server/.env
   chmod 600 server/.env
   ```
   - Generate a fresh random `JWT_SECRET` privately (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) and replace the placeholder in `server/.env`. Never commit or share `server/.env`.
   - Keep `API_RELEASE_PROFILE=full`, `ENABLE_CRON=0`, `QUOTA_SOURCE=monitoring`, `QUOTA_ACTION=stop`, `API_RUNTIME_SERVICE_ACCOUNT=owl-api-runtime@finder-owl.iam.gserviceaccount.com`, and exact `ALLOWED_ORIGINS` (including `https://finder-owl.web.app` and `https://finder-owl.firebaseapp.com`).
   - If you previously exported `ENV_FILE` for local MacBook testing, run `unset ENV_FILE`.
5. **Run local tests and deploy preflight**
   ```sh
   npm test
   npm run check
   node scripts/check-api-deploy.js
   ```
   - When Java is installed locally, also run `npm run test:firestore-rules` to validate `firestore.rules` in the official Firestore Emulator.
   - Note: `check-api-deploy.js` is local-only and does not verify live IAM bindings, Firebase authentication, Monitoring access, or production Firestore records.
6. **Authenticate Firebase CLI and deploy full Hosting + API**
   ```sh
   npx firebase-tools login
   npx firebase-tools projects:list
   npm run deploy:full
   ```
   - `deploy:full` runs `scripts/check-api-deploy.js`, stages the website into `.firebase-public` via `scripts/prepare-hosting.js`, and deploys `functions:api,functions:noticeRollover,hosting` to `finder-owl` using `firebase.json`. It does **not** deploy Firestore Rules.
7. **Verify the live deployment**
   - Check `https://finder-owl.web.app/` and `https://api.owlwatcher.tech/api/health` (expect HTTP 200 with `"accessMode":"firebase-full"`).
   - Check `https://us-central1-finder-owl.cloudfunctions.net/api/ads/global` and then `/api/quota` (confirm `source: "monitoring"`, `action: "stop"`, `monitoringUnavailable: false`, fresh `remoteCheckedAt`).
   - Confirm `GET /api/admins` without a token returns `401`, and verify staff login, society-scoped actions, CORS from `https://finder-owl.web.app`, and gift-code validation.
8. **Deploy hardened Firestore Rules separately (only after emulator + client verification)**
   - After `npm run test:firestore-rules` passes and you confirm no live web/Android client relies on direct Firestore writes or unlisted document reads outside `app_config/appVersion`, `ads/Aangan`, and `settings/contact`:
   ```sh
   npx firebase-tools deploy --config firebase.rules.json --project finder-owl --only firestore:rules
   ```

## Verification in this branch

`tests/firebase-api-server.test.js` runs the actual Firebase Function entry against an isolated local store fixture. It exercises Firebase token exchange, master-admin and guard profile access, permission denials, gift-code mint/validate/redeem, quota monitoring, and exact-origin CORS without connecting to Firebase. This is useful integration coverage, but it is not a production IAM check or a substitute for running the official Firestore Rules Emulator.
