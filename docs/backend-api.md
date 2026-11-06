# Owl Watcher backend API

Backend code lives in `server/`. It is deployed to the API host (`api.owlwatcher.tech`), separately from the static frontend.

```
server/index.js               Express app and all routes
server/lib/version-policy.js  App-version validation/comparison
server/lib/auth.js            Firebase ID token + backend JWT verification
server/lib/security.js        CORS allow-list and App Check enforcement
```

## Setup

```sh
npm ci
cp .env.example .env      # then fill in JWT_SECRET and credentials
node server/index.js
```

`JWT_SECRET` is now **required** and must be at least 32 characters. Generate one:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The server refuses to start without it. The old `'your-super-secure-secret-key'` fallback is gone.

## Bugs fixed relative to the previous server

### 1. Admin writes always returned 403

`app.js` `authenticatedFetch()` sends a **Firebase ID token**:

```js
headers['Authorization'] = `Bearer ${idToken}`;
```

The old `verifyAuthToken` verified it with `jwt.verify(token, JWT_SECRET)`. Google signs ID tokens, so this always threw and every admin write (guards, vehicles, notices, facilities, bookings, ads, limits) failed with `403`.

`server/lib/auth.js` now inspects the token issuer and routes it correctly:

- Firebase ID token → `getAuth().verifyIdToken(token, true)` (also checks revocation)
- Backend JWT from `/api/auth/token` → `jwt.verify(token, JWT_SECRET)`

### 2. Any short string authenticated as a user

```js
// REMOVED
if (token === "owl-watcher-session-token" || token.length < 50) { ... next(); }
```

`Authorization: Bearer x` used to grant write access to guards, notices, and config. Removed entirely; no frontend code used that path.

### 3. Origin was treated as authentication

The old middleware called `next()` whenever `Origin` matched, so App Check was never verified. `Origin` is a client-controlled header — any script can send `Origin: https://localhost`.

Origin is now used **only for CORS**. App Check is verified cryptographically. Matching also became exact instead of `startsWith`/`includes`, which previously allowed `https://localhost.evil.com` and `https://ngrok-free.dev.attacker.com`.

### 4. Missing routes

Added handlers the frontend already calls: `GET /api/societies/:id`, `PATCH /api/societies/:id/limits`, `PATCH /api/societies/:id/flats`, `PATCH /api/ads/:adKey`, and `GET /api/admins/verify-society`.

### 5. Other hardening

- Admin writes require a verified admin role; residents keep unauthenticated vehicle registration and contest spins.
- Editing an existing vehicle by `id` now requires admin.
- Contest spin counting uses a Firestore transaction instead of read-then-write.
- Body size limits, stricter auth-endpoint rate limits, and a JSON error handler.

## App Check rollout

`APP_CHECK_MODE` controls enforcement:

| Mode | Behaviour |
| --- | --- |
| `off` | Ignore App Check tokens (local development) |
| `monitor` | Verify when present, log failures, allow the request (**default**) |
| `enforce` | Require a valid token; return `401` when missing or invalid |

Deploy with `monitor` first, confirm `[app-check] Verification failed` stops appearing in logs, then switch to `enforce`. This avoids locking out users while native attestation is still being fixed.

## App version endpoint

```
GET /api/app-version
GET /api/app-version?platform=android&version=2.7.0
```

Reads `app_config/appVersion` using the **Admin SDK**, which bypasses Firestore rules *and* App Check enforcement. The update popup therefore works even while native attestation is broken.

Response for the query form:

```json
{
  "platform": "android",
  "installedVersion": "2.7.0",
  "configured": true,
  "minimumVersion": "2.8.0",
  "storeUrl": "https://play.google.com/store/apps/details?id=io.github.prsd503.owl",
  "updateAvailable": true,
  "message": "A newer version is available."
}
```

Without query parameters it returns the full normalized policy. Invalid platform blocks are dropped individually, so the current `ios.storeUrl: "www"` reports `configured: false` for iOS without hiding Android.

`update-popup.js` now calls this endpoint first and falls back to the direct Firestore read if the API is unreachable, so the popup keeps working during an API outage.

## Login failures in the guard and admin portals

**This is not caused by the backend.** Both portals sign in directly against Firebase:

```js
await signInWithEmailAndPassword(auth, email, pass);
```

That request goes to `identitytoolkit.googleapis.com` and never reaches this server. If **App Check enforcement is enabled for Firebase Authentication**, sign-in requires a valid App Check token — which the device currently cannot produce (`403 App attestation failed`, then DNS failures).

Fix in Firebase Console → **App Check → APIs → Firebase Authentication** → set enforcement to **Unenforced/Monitor**. Keep Firestore enforced if desired. Re-enable Auth enforcement only after attestation works; see [the App Check guide](app-check.md).

For the web portals, also confirm `prsd503.github.io` and `app.owlwatcher.tech` are registered domains for the reCAPTCHA v3 key used in `app.js`.

## Validation

```sh
npm ci
npm test        # 67 tests
npm run check
```
