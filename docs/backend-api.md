> **Security update:** Sign-in is not app authorization. The staged API resolves
> current staff memberships from Firestore `admins`/`guards`, binds them to a
> verified Firebase email (and a stored UID when present), and scopes regular
> administrators/guards to one canonical society. Only `admins.isMaster === true`
> is global. Token role claims and `ADMIN_UIDS` do not grant access. This code is
> not deployed; the live Firebase pilot remains read-only.

> **Deployment update:** Hostinger is no longer the default API target. See
> [Firebase deployment and quota cutoff](deployment.md) and
> [MacBook testing](macbook-testing.md). `/api/health` and `/api/quota` expose
> diagnostics. A drained API returns 503 with `X-Owl-Drain: 1` and
> `code: "quota-threshold-reached"` (or `quota-monitoring-unavailable`).
> The normal API/Auth/App Check contracts below remain in place.

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

- Society-scoped writes require an active Firestore `admins` membership; guards are limited to their society and cannot use admin mutations; global settings/code issuance require `admins.isMaster === true`.
- Vehicle enrollment remains guest/resident-facing, but server transactions enforce canonical society, flat membership, device/flat locks, duplicate plates and configured limits. Public vehicle/contest lookups query by plate, flat, or device rather than bulk-reading a society collection. Public plate searches return only plate/flat; resident details require an exact device-to-flat match, while unbound legacy records return slot counts only. Device IDs are spoofable and are not strong residency proof.
- Contest spin eligibility, single-use attempts and winner claims are checked server-side in transactions against the registered device/flat; the client sends the existing device ID and contest identifier.
- Sensitive API responses use explicit projections; Firestore Rules deny direct client reads/writes except narrow compatibility gets.
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

## Bulk vehicle import (admin portal)

```
POST /api/vehicles/import      (admin token, society-scoped)
{ "society": "Aangan", "rows": [{ "vehicleNumber", "flatNumber", "residentType", "mobileNumber", "vehicleType" }] }
```

Validates the whole file first, then writes in batches of 400. Existing plates
are updated only when a field actually changes; identical rows and repeated
plates in the same file are counted as `repeat`; rows with an unknown flat, a
missing plate, a bad resident type/mobile, or a device-linked vehicle asked to
change flat are counted as `rejected` with a reason. The response is the report
the admin portal renders: `{ total, added, updated, repeat, rejected, changes[], errors[] }`.
Up to 2000 rows per request.

## Sign-in eligibility (public)

```
POST /api/auth/staff-role   { "email": "name@example.com" }
→ { "success": true, "role": "admin" | "master" | "guard" | null }
```

Answers which staff role an address holds, so the admin and guard sign-in pages
can refuse a stranger **before** Firebase creates a session. Rules:

- Reads Firestore `admins` then `guards`; disabled / inactive records never count,
  and an address with ambiguous legacy admin records returns `null`.
- `null` is also the answer for an unknown address and for an internal failure,
  so the response cannot be used to tell "no account" from "lookup broke".
- Rate-limited by the sign-in limiter (30 per 15 min per IP), `Cache-Control:
  no-store`, and it grants nothing: `GET /api/admins` and `GET /api/guards` still
  require a token, and the ID-token membership check after sign-in remains the
  real gate.

The pages use it as a pre-check only. Admin: `null` → *"This email is not
registered as a society admin…"*, `guard` → *"This email is registered as a
guard, not a society admin…"*. Guard: `null` → *"This email is not registered as
a security guard…"*, `admin`/`master` → *"This email is registered as a society
admin, not a guard…"*. A failed lookup says so instead of claiming the email is
invalid, and a post-sign-in membership failure still signs the user out with the
same message.

## Resident vehicle entry (entry.html)

```
POST /api/vehicles        { societyName, flatNumber, residentType, mobileNumber, deviceId, vehicles }
```

This is a public write: the resident page does not require a bearer token. When
the host page does have a Firebase session it installs `window.OWL_GET_ID_TOKEN`
and the page exchanges that ID token at `POST /api/auth/token` for the API JWT.
Without such a provider the page skips the exchange entirely instead of
requesting a token that can only answer `400 Firebase ID token is required`.

`vehicles` accepts every shape a client may send. The parser used to read only
`vehicle.vehicleNumber`, so bare strings and `plate` / `vehicle_no` keys were
silently discarded and the caller got `400 At least one vehicle number is
required` while the resident had typed one:

| Payload | Meaning |
| --- | --- |
| `[{ vehicleNumber, vehicleType }]` | canonical |
| `["GJ01AB1234", …]` | array of plates |
| `[{ plate \| vehicle_no \| number \| regNumber, type }]` | aliased keys |
| `{ vehicleNumber, vehicleType }` | single object instead of an array |
| `'["GJ01AB1234"]'` or `"GJ01AB1234,GJ01CD5678"` | JSON / comma-separated string |
| `vehicleNumber` on the body | no `vehicles` field at all |

Duplicates inside one request collapse to one entry; a plate that is not exactly
10 letters/digits is rejected naming the rule. A JSON body labelled
`text/plain` is accepted, because that is what a browser sends once a page loses
its `Content-Type` header — the plate must not be lost over a header.

Two failure codes keep "you forgot the plate" separate from "the plate was never
readable":

| Response | When |
| --- | --- |
| `400 { code: "vehicle-number-required", field: "vehicles" }` | body parsed, no plate in it |
| `400 { code: "unreadable-body" }` | body type is not parsed at all (e.g. `multipart/form-data`), so a typed plate would silently disappear |

The page turns `vehicle-number-required` into a message naming the plate it
actually sent, rather than asking the resident to type a number that is already
on screen.

The page also mirrors the server's allowance defaults (2 two-wheelers, 1
four-wheeler) when a society has never configured limits, so the resident is not
shown a form with no fields; the submit button appears only once a plate is
typed, and a flat with no allowance left says so.

## Flat numbers for the vehicle form (admin portal)

```
GET /api/societies/:societyIdentifier/flats   (admin token, that society or master)
→ { societyId, society, flats[], max2Wheeler, max4Wheeler, counts{ flat: { '2-Wheeler', '4-Wheeler', other } } }
```

`societies/:id/flatList`, de-duplicated and in natural order, plus the current
per-flat vehicle counts. The admin add/edit form uses `flats` as its dropdown;
`POST /api/vehicles` still re-validates and answers `400 Flat is not registered
in this society.` for anything else.

**Per-flat allowances.** `PATCH /api/societies/:id/limits` sets
`max2Wheeler` / `max4Wheeler` (0-100). Every vehicle write - admin edits
included - refuses to take a flat past its allowance with
`409 { code: "vehicle-limit-reached", error: "This flat already has N 4-Wheeler(s),
the allowance in <society>. Increase the limit under vehicle allowance limits
first." }`. A society that has never set limits keeps the defaults 1 / 2. An
edit that keeps the same plate on the same flat and type is never blocked by an
already-full flat.

## Society spin counts (master login)

```
GET  /api/contest/spinstats?societyName=Aangan      (master token)
POST /api/contest/spinstats/backfill                (master token) { societyName }
```

`POST /api/contest/spin` writes one document per society per **UTC** day:

```
spinStats/aangan_2026-11-04 = { createdAt, date: "2026-11-04", societyName: "Aangan", spinCount: 1 }
```

Documents created before `societyId` was stamped carry only `date`,
`societyName` and the `<societyLowercased>_<date>` document id. Because
`GET …/spinstats` used `where('societyId', '==', id)`, those documents were never
returned and the master page showed *"Society data not found or invalid
response."* The read now tries the indexed query and then scans the collection,
matching on `societyId`, **or** `societyName`, **or** the document id prefix, and
takes the date from the `date` field or the id suffix. One document per date is
counted (the largest `spinCount` wins if two collide).

```
→ { societyName, totalSpins, totalLifetimeSpins, totalDaySpins,
    totalMonthSpins, daysRecorded, documentsMatched, lastSpinDate, winnerFlat }
```

`backfill` stamps the missing `societyId` onto every matching document (batches
of 400, `merge: true`, safe to repeat) and returns `{ success, society, updated }`.
The master page exposes it as **Repair spin data** next to **Check spins**.

## Bulk delete vehicles (admin portal)

```
POST /api/vehicles/bulk-delete      (admin token, society-scoped)
{ "society": "Aangan", "plates": ["GJ01AB1234", "GJ01CD5678"] }
```

Deletes every listed plate that belongs to the caller's society, in batches of
400 (with per-document fallback), and returns
`{ total… requested, deleted, notFound, skipped, failed, plates[], missing[], errors[] }`.
Plates in another society are never matched. The admin portal reads the first
column of the uploaded CSV (its own template and export format), asks for
confirmation, and lists each plate as deleted / not found / skipped.

## Facility bookings (admin portal)

- `GET /api/bookings?society=<society>` returns `{ id, facilityId, start, end }`
  for the society; the admin portal joins `facilityId` with
  `GET /api/facilities/:society` to show the facility name, date and start/end
  times, sorted soonest first, each with a delete action.
- `POST /api/bookings` rejects a range where the end is not after the start
  (`400 Invalid booking date range`), and bookings may only be made from today
  up to 6 months ahead.
- `DELETE /api/bookings/:id` is limited to admins of that booking's society.
- Bookings older than **7 days** are deleted automatically by the scheduled
  maintenance job; the admin list hides them in the same window so an expired
  booking never appears as active before the clean-up runs.

## Vehicle registry (admin portal)

`GET /api/vehicles?societyName=<society>&vehicleNumber=<plate>` with a staff token
returns the society's matching records (`id`, `vehicleNumber`, `flatNumber`,
`vehicleType`, `residentType`, `mobileNumber`, `deviceId`), which is what the
admin portal renders with its edit/delete actions.

`POST /api/vehicles` with a staff token is the add-or-edit write:

- no `id` → a new document is created;
- `id` → that document is updated, but only if it belongs to the caller's
  society (guards are refused entirely).
- Admin writes accept `2-Wheeler`, `3-Wheeler` and `4-Wheeler` (the resident
  entry flow stays limited to 2/4-wheelers).
- The flat must exist in the society's `flatList`, and a plate that already
  exists in the society is rejected when creating a duplicate.

## Signed-in administrator profile

```
GET /api/admins/me        (staff token required)
```

Returns the caller's own membership resolved from the Firestore `admins` /
`guards` records: `{ email, society, societyId, isMaster }`. Pages that need the
administrator's society (for example the data deletion request, which names it
in the WhatsApp message) or the full-account deletion request use this instead
of trusting a URL parameter. The existing `GET /api/admins/:email` stays
master-or-self only. Both deletion pages also read the Owl Watcher team number
from `GET /api/config` (`configs/owlwatcher.teamPhone`) and keep a built-in
number only as an offline fallback.

## Facility calendar admin contact

```
GET /api/societies/:societyIdentifier/admin-contact
```

Public read (the facility calendar and the vehicle-entry page are
guest-facing). It resolves the
society the same way every other route does, then looks in the Firestore
`admins` collection for a record whose `societyId`, `society` or `societyName`
matches that society, and returns only the WhatsApp number:

```json
{ "societyId": "aangan", "society": "Aangan", "phone": "919033406816" }
```

- `phone` is normalised to digits (10–15, using `phone`, `whatsapp`,
  `whatsappNumber` or `mobile`) and is `null` when no active admin stored one;
  the page then shows "Admin contact not available."
- Used by `facility.html` ("Contact Admin via WhatsApp") and `entry.html`
  ("Contact admin on WhatsApp", whose chat text names the chosen flat).
- Records with `disabled: true` / `active: false` are ignored, and a
  society-scoped admin is preferred over a master admin's number.
- Nothing else from `admins` (email, uid, …) leaves the server, so Firestore
  rules can keep denying direct client reads of the collection.

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
