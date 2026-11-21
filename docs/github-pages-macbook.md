# GitHub Pages → MacBook → existing Firestore

Website: **https://prsd503.github.io/gor/index.html**

Allowed browser origin: **https://prsd503.github.io** (no `/gor` path in an origin).

## Status and scope: restricted connectivity preview, NOT a full public cutover

The MacBook has already passed local Firestore and Monitoring checks. The next
step is a deliberately **read-only public-content preview**. The old API includes
sensitive reads, anonymous mutations and endpoints without society-level
permissions. Opening the entire existing API with ngrok is not safe merely
because it uses Firebase sign-in or App Check.

This change fixes admin-on-sign-in elevation and provides `start:tunnel-preview`.
That profile denies everything except:

| Enabled GET/HEAD endpoint | Purpose |
| --- | --- |
| `/health`, `/api/health` | Basic backend status |
| `/api/ads/global` | Public global advertisements |
| `/api/ads/local/:id` | Public local advertisements (simple IDs only) |
| `/api/ads/greeting/:id` | Public greeting content (simple IDs only) |
| `/api/app-version` | Public version policy |

**Everything else returns 403 `tunnel-preview-restricted`, even with a token:**
login/token exchange, vehicle searches, societies, admin/guard records, bookings,
notices, config, gift redemption, `/api/quota`, private files and ALL POST/PATCH/
DELETE/PUT operations. In particular, the notices GET can perform writes, so it
is not allowed. Normal admin/resident/guard workflows are **not ready for public
use in this profile**. Do not promise residents that the site is fully working.

The profile disables static file serving and scheduled maintenance, retains
Firestore + Firebase Auth settings and Monitoring with `QUOTA_ACTION=stop`,
requires a threshold of at most 80%, and applies a 60-request/minute per-IP limiter
before Firebase work. The public preview CORS origin is exactly the GitHub origin
above; arbitrary ngrok-hosted frontends are not trusted. CORS is not authentication:
non-browser callers can still request intentionally public content. Provider-side
abuse controls remain necessary and the guard is not a guaranteed cost cap.

## 1. Get this change onto the MacBook first

These commands require the updated files from this branch to have been reviewed
and installed. Your previously downloaded ZIP does **not** update itself.
After merge, update a Git checkout normally; for a ZIP download, obtain the new
snapshot and carefully preserve the private `.env.macbook` from your existing
installation. Do not delete your old folder or overwrite credentials blindly.
Never upload that environment file into GitHub's web editor or commit it.

From the updated repository folder on your MacBook:

```sh
npm ci
npm test
```

The existing `.env.macbook` can be reused. It must contain a strong `JWT_SECRET`,
`FIREBASE_PROJECT_ID=finder-owl`, and `APP_CHECK_MODE=monitor` or `enforce`. The
launcher forces the restricted backend settings; it never rewrites that file.
Google Application Default Credentials remain outside the repository.

## 2. Start ONLY the restricted preview profile

Stop the older `start:firebase` / `start:local` process with Control-C. Then:

```sh
ENV_FILE=.env.macbook npm run start:tunnel-preview
```

This runs with `NODE_ENV=production`, no static files, no maintenance cron, the
quota guard enabled, and `TUNNEL_PREVIEW=1`. `monitor` App Check is acceptable
only for this narrowly public-content test; it is not evidence that the full
API is safe. `enforce` requires valid browser App Check tokens, including on ads.

Before creating the tunnel, use a second Terminal:

```sh
curl -i http://localhost:3000/api/health
curl -i http://localhost:3000/api/ads/global
curl -i http://localhost:3000/api/vehicles
curl -i -X POST http://localhost:3000/api/auth/token
```

Expected: health 200; ads 200 when Monitoring succeeds and quota is available;
vehicles and token exchange 403 with `tunnel-preview-restricted`. A 503 on ads
must be diagnosed, not worked around with `QUOTA_ACTION=off`. In this profile
`/api/quota` is intentionally blocked publicly; stop the tunnel and return to the
local Firebase profile if you need its full diagnostics.

## 3. Start the HTTPS tunnel

ngrok 3.39.10 is already installed on your MacBook. In a separate Terminal:

```sh
ngrok http 3000 --inspect=false
```

If ngrok needs authentication, sign into your ngrok dashboard and follow its
local setup instructions. Never paste the ngrok auth token into chat, a screenshot,
`api-env.js`, or GitHub. `--inspect=false` disables local request inspection.

Look for:

```text
Forwarding  https://YOUR_ASSIGNED_HOST → http://localhost:3000
```

Keep both Terminal windows running. Share only the **HTTPS hostname**, not a
token. Use your actual assigned/stable hostname; do not invent one. Some ngrok
plans include a static development hostname. If your hostname changes, frontend
configuration must be republished. Reserve it before relying on it.

Validate via that URL:

```sh
curl -i 'https://YOUR_ASSIGNED_HOST/api/ads/global' \
  -H 'Origin: https://prsd503.github.io' \
  -H 'ngrok-skip-browser-warning: true'

curl -i 'https://YOUR_ASSIGNED_HOST/api/vehicles' \
  -H 'ngrok-skip-browser-warning: true'
```

The first should be JSON, 200 and `Access-Control-Allow-Origin:
https://prsd503.github.io`; the second must stay 403. Direct Safari navigation may
show ngrok's interstitial. API fetches to configured ngrok bases now automatically
send the warning-bypass header; it is not an authentication secret.

## 4. Configure the published frontend only after the hostname is verified

In the updated repository (on a working branch):

```sh
# Preview the generated config without writing anything:
npm run api:configure -- https://YOUR_ASSIGNED_HOST

# Only after checking the hostname belongs to you:
npm run api:configure -- https://YOUR_ASSIGNED_HOST --write
```

This changes **only `api-env.js`** to use `https://YOUR_ASSIGNED_HOST/api` as the
primary API, with no fallback that might send blocked preview operations to some
other backend. It does not touch credentials and it does **not** publish the site.
Without the hostname we intentionally leave the existing endpoint unchanged.

Review and commit that public file through the normal PR process. A ZIP checkout
has no Git metadata: either publish the reviewed `api-env.js` through GitHub's
file editor/PR workflow or use a real Git clone. Do not upload your whole local
folder with credentials. Wait for the existing GitHub Pages build/deployment to
complete before testing. This repository does not add/change your Pages publishing
source or assume that a branch commit instantly goes live.

To avoid interrupting the current public site, you can first publish the tunnel
as a trusted `local` base in `api-env.js` while leaving `primary` unchanged, then
open the page with `?api=` set to that URL for a single-page pilot. Query overrides
only work for preconfigured trusted bases; this is endpoint selection, not a
security boundary. Inspect network requests to ensure that page is using the
expected server. Only promote it to primary when the intended limited test is
acceptable to website users. The helper above switches the primary, so use it
only when intentionally ready for that preview cutover.

## 5. Verify the actual GitHub Pages page

Open https://prsd503.github.io/gor/api-env.js and confirm the new HTTPS base.
Then hard-refresh the website, or use a private browser window so an older
remembered fallback is not reused. A developer can inspect:

```js
OWL_API.status()
```

In browser developer tools → Network, verify advertisement requests go to the
ngrok hostname and return JSON. The private/disabled routes should return the
explicit 403 preview message, not data. Do not switch off the gate to remove
those errors. Keep Hostinger running until the intended replacement is fully
verified; this preview is not a finished production migration.

## Administration compatibility/security change

Previously any Firebase sign-in defaulted to admin, and `/api/auth/token` issued
an admin backend JWT to every verified account. Those defaults are removed.
A verified Firebase user now needs an actual `admin: true`, `role: 'admin'` or
`adminRole: 'admin'` **custom claim**, or their exact UID in the server's comma-
separated `ADMIN_UIDS` environment setting. User-editable profile documents,
email matching, and browser localStorage flags do not grant backend admin rights.

Only the project owner should grant global admin privileges, via trusted Firebase
Admin tooling or `ADMIN_UIDS` (look up UIDs in Console → Authentication → Users).
Do not put ordinary residents/guards/society admins in a global admin allowlist.
There is no public endpoint to grant claims. No production accounts/claims were
modified by this code change.

Legacy backend JWTs lacking the new `authVersion: 2` marker no longer confer
admin authority. Authorized staff should sign in/exchange a new token. Existing
Firebase ID tokens are reclassified from verified claims on each authenticated
request. Changing `ADMIN_UIDS` requires restarting the server; an already minted
v2 backend token can retain its role until its one-hour expiration. Rotate the
backend JWT secret if immediate backend-session invalidation is required.
The normal API still needs resource/society-level authorization beyond this global
admin fix. The restricted preview avoids exposing it while that work is pending.

## Before a full public rollout (not completed by this preview)

- Add/test server-side society/resource authorization for admin and guard reads
  and writes; Firebase sign-in alone must not grant access to other societies.
- Protect resident registration, contest writes and account-recovery flows against
  anonymous abuse without relying on Origin/CORS as proof of identity.
- Minimize public response fields and verify no personal/contact data leaks.
- Verify browser Auth and App Check for every relevant flow. Many existing fetch
  calls do not attach App Check; setting `enforce` alone will break those calls.
- Use a least-privilege runtime identity rather than broadly privileged personal
  ADC for sustained public hosting. Use a stable HTTPS hostname, managed process,
  safe secrets, OS updates, backups and provider-side rate/abuse controls.
- Keep the MacBook awake (`caffeinate -i` can help during a supervised test).
  Sleep, loss of Wi-Fi or closing the server/tunnel stops the backend.
- Roll back by restoring the previous reviewed `api-env.js` and republishing,
  then stopping ngrok. Do not publish an unverified cloud endpoint as a fallback.

The MacBook still uses the same Firestore quota. At 80% of a tracked allowance
it pauses work; moving compute from Hostinger/Functions to the MacBook does not
reset or bypass the Firestore allowance.
