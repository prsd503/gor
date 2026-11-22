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

Publish the reviewed changes to **both `api-env.js` and `api-config.js`** through
the normal PR process: the router must support `testBases` as well as the new
configuration. A ZIP checkout has no Git metadata, so use a real Git clone or
the reviewed GitHub PR workflow rather than uploading your entire local folder.
Never upload credentials. No MacBook environment changes are needed for this
frontend-only update; keep its existing restricted server and tunnel running.

Wait for the existing GitHub Pages build/deployment to complete before testing.
This repository does not change your Pages publishing source or assume that
changes saved on an Arena branch are automatically live. Do not run the
primary-switching helper for this pilot; follow the opt-in configuration below.

### Recommended first pilot: test-only endpoint, no automatic fallback

For the verified MacBook tunnel, `api-env.js` now leaves `primary` unchanged,
keeps `local` empty and `fallbacks` empty, and registers:

```js
testBases: ['https://unloving-limit-ferry.ngrok-free.dev/api']
```

**`testBases` is an opt-in trust list, not a fallback list.** An ordinary page
load never selects these endpoints, even if the primary fails or browser storage
contains an old remembered test selection. Do not put this restricted tunnel in
`local` or `fallbacks`: those settings enable automatic failover for visitors.
The primary URL remains the previously configured Firebase URL; leaving it
unchanged does not verify that the Firebase function is deployed or working.

After this change is merged and GitHub Pages finishes publishing, open:

https://prsd503.github.io/gor/index.html?api=https%3A%2F%2Funloving-limit-ferry.ngrok-free.dev%2Fapi

That page load is pinned to the exact trusted tunnel base. Previously remembered
primary/fallback state cannot override it. A failure, quota drain or restricted
403 is surfaced there, never retried against the primary API. The selection and
its success/failure do not write normal routing state to localStorage. It applies
only to that page: following a link without `?api=` returns to ordinary routing.
This is a test endpoint selector, **not** a replacement for backend access controls.

Remove the `?api=...` query and reload to exit. If the hostname changes, remove or
replace its `testBases` entry, review the new address and republish before using a
new test link. Retire a tunnel entry promptly when it is no longer controlled by
you; an ngrok address in frontend config is public and must not be treated as a secret.

Do not run the `api:configure --write` helper for this opt-in pilot: that helper
intentionally replaces the primary configuration. Promoting this restricted API
to primary would break private/search/write features for visitors. No automatic
primary cutover is part of this pilot.

## 5. Verify the actual GitHub Pages page

Open https://prsd503.github.io/gor/api-env.js and confirm the tunnel appears in
`testBases`, **not** in `primary`, `local` or `fallbacks`. Hard-refresh or use a
private browser window if cached files do not show the new configuration. Open
the full opt-in link above (not just the plain index URL). A developer can inspect:

```js
OWL_API.status()
```

`OWL_API.status()` should show the ngrok URL in `active` and `pageOverride`, and
only that URL in `bases`. You can perform a read-only browser-side health check:

```js
fetch(OWL_API.url('/health')).then(r => r.json()).then(console.log)
```

It should report `accessMode: 'tunnel-preview'`. In developer tools → Network,
verify advertisement requests go to the ngrok hostname and return JSON. The
private/disabled routes should return the explicit 403 preview message, not data.
Do not sign in, submit forms or expect searches/registration to work in this pilot.
Do not switch off the gate to remove errors. Hostinger is not an authorized backend target; this pilot is still not a finished production migration. It does not cancel a Hostinger plan or change DNS.
Also open the plain index URL in a different tab and verify normal API routing
does not use ngrok. Browser tests here are separate from the user's earlier
Terminal health/CORS checks; mocked automated tests do not prove a live tunnel
or GitHub Pages deployment is available.

## Administration compatibility/security change

The staged full-API code no longer treats Firebase custom role claims, `ADMIN_UIDS`,
email queries from the browser, or localStorage flags as authorization. It resolves
current staff membership from Firestore `admins` and `guards` records. The signed-in
Firebase email must be verified; a stored UID on the membership record must match.
Regular admins and guards are confined to one canonical society. Only
`admins.isMaster === true` grants global scope. Membership is re-read for protected
requests so deleting or changing the record revokes access without waiting for a
role-bearing JWT to expire.

This policy and the related server/Rules changes are **staged source only**. The
production Firebase Function still rejects private routes and all writes before
Firestore access. Do not disable the gate, grant runtime write IAM, change DNS,
move GitHub Pages/Android to a different backend, or publish a full app from this
preview. Stop using Hostinger for backend hosting; cancellation or DNS cleanup is
a separate action and has not been performed here.

## Current full-release blockers

- The supplied Rules were reviewed as source but the deployed Ruleset was not
  fetched. Run the Firestore Emulator Rules tests and review direct fallbacks for
  all client builds before an independently approved Rules release.
- `admins.isMaster` and society memberships are security-critical data. Their
  account binding, revocation, canonical IDs, and legacy aliases need production
  owner review; this code does not modify production membership records.
- Device ID remains client-controlled and spoofable. Server transactions enforce
  vehicle/contest locks against ordinary bypasses, but this is not proof of human
  residency or ownership. Public resident screens still require a compatibility
  read of limited flat/vehicle fields; phone/device-only access cannot be made
  high-assurance without a separate identity proof.
- Firebase runtime identity is currently Datastore Viewer. The full write API is
  not ready for production until least-privilege write IAM is separately reviewed.
- Verify Android App Check/WebView and GitHub Pages behavior end-to-end. This
  repository's mocked/local tests do not substitute for a live integration test.
- Keep the MacBook awake (`caffeinate -i` can help during a supervised test).
  Sleep, loss of Wi-Fi or closing the server/tunnel stops the backend.

## Operational notes

- Use a stable HTTPS hostname and provider-side rate/abuse controls for any later
  approved release. Quota alerts and the 80% guard are not a hard billing cap.
- Restore only a previously reviewed `api-env.js` for rollback, then stop ngrok.
  Do not publish an unverified cloud endpoint or use Hostinger as backend fallback.

The MacBook still uses the same Firestore quota. At 80% of a tracked allowance
it pauses work; moving compute between Firebase Functions and the MacBook does not
reset or bypass the Firestore allowance.
