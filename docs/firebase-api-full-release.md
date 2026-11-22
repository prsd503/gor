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

`ENABLE_CRON=0` remains intentional: this release exports an HTTP Function only. Scheduled maintenance is not part of this release profile.

## Correct deployment target

The **main website plus API Function** uses `firebase.json`:

- Hosting stages the explicit website allowlist into `.firebase-public`.
- Functions deploys `server/firebase.js` as `functions:api` in `us-central1`.
- The website's `api-env.js` points to the Function URL.
- The config has no Firestore Rules section. `deploy:full` selects only `functions:api,hosting`.

`firebase.api.json` is an API-only Hosting site with small landing/404 pages; it is not the full website.

## Required setup before deployment

1. Create `server/.env` privately from `server/.env.firebase.example`. Use a fresh random `JWT_SECRET`; do not send it in chat or commit the file. `API_RELEASE_PROFILE=full` is mandatory.
2. Provision a dedicated runtime service account such as `owl-api-runtime@finder-owl.iam.gserviceaccount.com`. The current deployed account is **Datastore Viewer** and cannot perform Firestore writes. Review the minimum Firestore entity read/write IAM permissions, plus Monitoring Viewer. A predefined `roles/datastore.user` grant is write-capable but must be reviewed for scope; do not grant Owner or Editor. The local preflight validates the account name, not its live IAM bindings.
3. Confirm the deployed membership data has verified-email and UID bindings, active admin/guard records, and canonical society IDs. Verify role scopes and master access against representative fixtures before production release.
4. Run the Firestore Rules Emulator suite when the official Emulator JAR is available. The current sandbox could not download it, so this branch's Rule semantics are not Emulator-validated.
5. Authenticate Firebase CLI in an authorized environment. Do not paste credentials, tokens, or filled `.env` contents into chat.

## Local verification and deployment commands

```sh
npm test
npm run check
node scripts/check-api-deploy.js
```

The preflight is local-only. It does not prove the service account's IAM, Firebase authentication, production data compatibility, Monitoring access, or route behavior against live services.

After those items are reviewed, the full website and API Function deployment command is:

```sh
npm run deploy:full
```

It targets `finder-owl` with `firebase.json` and selects Hosting plus `functions:api`; it does **not** deploy Firestore Rules. Do not use `npm run deploy:api:hosting` for the main website.

## Verification in this branch

`tests/firebase-api-server.test.js` runs the actual Firebase Function entry against an isolated local store fixture. It exercises Firebase token exchange, master-admin and guard profile access, permission denials, gift-code mint/validate/redeem, quota monitoring, and exact-origin CORS without connecting to Firebase. This is useful integration coverage, but it is not a production IAM check or a substitute for running the official Firestore Rules Emulator.
