# Reducing Firebase cost — audit and action plan

> Scope: the Express API in `server/`, the quota guard (`server/lib/quota-*`),
> the Cloud Functions wrapper (`server/firebase.js`) and the static site's
> request patterns. Line numbers refer to this commit. **Nothing here is
> implemented yet** — every section states what to change and what it saves.

**Units used below:** *read* = Firestore document read (free tier 50,000/day),
*write* = document write (20,000/day), *delete* (20,000/day), *inv* = Function
invocation (2M/month), *egress* = Function/Cloud Run bytes out (5 GB/month),
*$* = a separately billed product the quota guard does not watch.

---

## 0. What already works (keep it)

- Browsers never read application data from Firestore directly: `firestore.rules`
  allows only three public documents. Reads are counted in **one** place.
- `server/lib/db-layer.js` has a TTL read cache (20 s) and writes invalidate the
  collection they touch.
- New vehicle / guard / booking documents carry `societyId`, so the legacy
  "scan and filter in JS" paths *should* be rare.
- No scheduled Function, no cron on Firebase (`ENABLE_CRON=0`) — idle is free.
- `minInstances: 0`, `maxInstances: 2`, `concurrency: 20` — right for a
  near-zero-cost target.
- Maintenance is on-demand only (master portal buttons), nothing runs on a timer.

---

## 1. The biggest cheap win: the pages still use a "probe, fail, retry" pattern

Four pages were written against an older backend and still pay for requests that
cannot succeed:

| Page | Line | What happens |
| --- | --- | --- |
| `index.html` | 522-524 | `POST /api/auth/token` with **no body** → server answers `400` (`server/index.js:709`), every single load |
| `facility.html` | 105-107 | same empty-body call, **twice** per load (`getAuthHeaders()` at 201 and 221) |
| `notice.html` | 73-75 | same empty-body call |
| `index.html` | 1254-1255 and 1242 | `/api/config` fetched, then `updateContactUsWhatsAppLink()` fetches it again |
| `index.html` | 1071-1081 | `/ads/local/<id>` re-requested with `.toLowerCase()` and again with `currentSociety` |
| `index.html` | 880-884 | `/active-guard` re-requested when the first guess 404s |
| `facility.html` | 212-241 | `/bookings` re-requested for `Aangan` when the first answer is empty |
| `entry.html` | 481-489 | one `GET /vehicles?vehicleNumber=` **per plate** on submit — up to 12 requests for one registration |
| `entry.html` | 425 + 302 | every 350 ms typing pause in the flat field fires a full `/vehicles` lookup |
| `admin-logic.js` | 358 | reads **all** society vehicles just to count one flat's vehicles, then the server re-checks the same allowance |
| `admin-logic.js` | 1635 | export re-reads all vehicles through the same list route |

Each attempt is a billed invocation; the ones that reach a route do Firestore
work too. Counting the above, a single home-page load with a saved society
currently makes **8-10 invocations** (3 are guaranteed-to-fail token exchanges,
2 are the same `/config` answer, and only 4 actually return data) before the
user has done anything.

**Fix**
- Delete the empty `POST /api/auth/token` calls. All the endpoints these pages
  use are public and accept an anonymous caller — `entry.html`'s own comment
  (line 114-119) already says so.
- Resolve the society once (`/api/societies/verify`) and reuse the canonical
  `id` it returns; never guess a casing and retry.
- Memoise `/api/config` (memory + `localStorage` TTL) and call it once. The
  response is already `max-age=60`, but the second call is not guaranteed to hit
  the HTTP cache.
- Drop the client-side duplicate/allowance pre-checks: `POST /api/vehicles`
  already enforces both atomically inside a transaction and returns `409` with a
  code the pages can display. Replace the per-plate pre-check with one submit.
- Debounce the flat lookup to `change`/blur, or wait for a plausible flat value.

**Impact: inv −40-60 % on public pages, read −15-25 %.**

---

## 2. `fresh: true` cancels the cache on the hot paths

`db-layer.js`'s cache exists to absorb exactly this traffic, but 13 call sites in
`server/index.js` and 13 in `server/lib/*` pass `{ fresh: true }`, and every
transaction read bypasses the cache by design.

| Site | Line | Why it matters |
| --- | --- | --- |
| `authorization.resolveSociety()` fallback scan | `server/lib/authorization.js:29` | **full `societies` collection read on every display-name lookup**, never cached |
| `resolveSociety()` direct get | `authorization.js:23` | 1 read per lookup even when the id is known |
| `membershipRecords()` scans | `authorization.js:65,72` | when the email-keyed admin doc is missing, the whole `admins` (then `guards`) collection is read, per request |
| `lookupStaffRole()` | `authorization.js:146,150` | same scan on every sign-in attempt, including the two field checks on the entry page |
| `GET /api/societies/:id/flats` | `server/index.js:1223` | full society vehicle read (`fresh`), on every admin login |
| `GET /api/vehicles` guest/resident branches | `server/index.js:984,992` | full society vehicle read (`fresh`); `984` is outside a transaction, `992` feeds one |
| `POST /api/vehicles` transaction | `server/index.js:1408` | full society vehicle read (transactions are never cached) — see §3 |
| spin stats | `server/index.js:625` | whole `spinStats` collection (`fresh`) — see §5 |

`resolveSociety` is called from **22** places in `server/index.js`, and
`optionalAuth` + `requireStaff` re-resolve membership on every privileged call,
so the scans above dominate the read budget during sign-in and admin work.

**Fix**
- Remove `fresh: true` from read paths and rely on write invalidation (the layer
  already invalidates on `set/update/delete/add/batch/transaction`). Keep `fresh`
  only where a stale answer is unsafe: gift-code redemption and gift-code
  validation.
- Add an `aliasIndex` collection (`normalizedAlias -> societyId`, written when a
  society is created/renamed) so `resolveSociety` is 1-2 reads instead of a
  collection scan. Cache positive lookups with a 10-15 min TTL.
- Cache the direct-miss result for `admins`/`guards` membership with a short
  negative TTL so a stranger's repeated `auth/staff-role` probes don't rescan.

**Impact: read −50-70 % on admin/staff paths, −30 % overall.**

---

## 3. `POST /api/vehicles` reads the whole society inside a transaction

`server/index.js:1403-1412`: when the society has **no configured `flatList`**
the registration reads every vehicle in the society, through all three
`vehicleSocietyQueries`, inside the transaction. The route defaults to
`'Aangan'` (line 1301), so this is the most common resident flow. With N
vehicles that is ~3N reads **per registration**, and a contended transaction
re-runs the whole read set.

**Fix**
- Backfill `flatList` for every society (admin portal can set it, master can
  script it). With a flat list the cheap per-flat query path is used.
- For legacy societies, add a normalised `flatLower` field on write and query
  it; that removes the only reason for the full scan (case-insensitive matching).
  Keep the scan behind a one-off migration script.
- The society-wide vehicle *cap* still needs a count — use `count()` (§10) or a
  maintained `vehicleCount` field on the society document instead of reading
  every vehicle.

**Impact: read from O(society size) → O(flat size) on the busiest write path.**

---

## 4. Legacy triple-query fan-out

Even with `societyId` present, the code still fires the legacy `societyName` /
`society` queries in parallel. Each query is billed at its own result size
(minimum 1 read), so three overlapping queries cost ~3× once there is data.

| Function | Line | Queries |
| --- | --- | --- |
| `vehicleSocietyQueries()` | `server/index.js:381-386` | 3 (`societyId`, `societyName`, `society`) |
| `bookings` route | `server/index.js:1165-1169` | 3 |
| `guards` directory | `server/index.js:920-923`, `2012-2014` | 3 each |
| `findSocietyAdminRecords()` | `server/index.js:550-552` | 3 `in` queries over up to 30 aliases |
| `getSocietyDocument()` | `server/index.js:582-597` | up to **30 doc gets + 3 queries** |
| `vehicle-import.js` preload | `server/lib/vehicle-import.js:85-88` | 3, `fresh` |
| `vehicle-bulk-delete.js` preload | `server/lib/vehicle-bulk-delete.js:63-65` | 3, `fresh` |
| `vehicle-import.js` per chunk | `vehicle-import.js:233-237` | 3 inside **each** 100-row transaction |

The result is cached 20 s in most routes, but any write to the collection
invalidates it — and vehicle writes are frequent.

**Fix**
- Query `societyId` first and only run the legacy query **if it returned zero
  documents**. The results are already merged into a `Map`, so this is a
  short-circuit, not a rewrite. Where `societyId` is known to be complete for
  current data (it is written on every create since this change), delete the
  legacy query outright.
- `getSocietyDocument()`: `notices` and `facilities` are written keyed by
  `society.id` (`server/index.js:1867,1946`), so a single `doc(id).get()` is
  enough. Keep the scan as a fallback only when that document is missing, and
  `break` on the first hit rather than probing 30 names.
- `vehicle-import`: read the registry once, not per chunk.

**Impact: read −55-65 % on vehicle, booking, guard and notice routes.**

---

## 5. Full-collection scans on public endpoints

| Route | Line | Current cost |
| --- | --- | --- |
| `GET /api/ads/local/:deviceId` | `server/index.js:788` | reads **every** `ads` document, then matches one by lower-cased id |
| `GET /api/ads/greeting/:id` | `server/index.js:808` | same full scan |
| `POST /api/contest/spin`, `/winner` | `server/index.js:510-514` (`getVehiclesForDeviceInTransaction`) | `vehicles.where('deviceId','==')` with **no `.limit()`** — billed at result size on every spin and every claim |
| `GET /api/contest/spinstats` | `server/index.js:616-629` | deliberately reads the **entire** `spinStats` collection (`fresh`) *in addition to* the per-society query, on every master dashboard load |
| `latestWinnerFlat()` | `server/index.js:632-641` | reads every `winners` document for the society and sorts in JS |

`ads` is keyed by society id in practice, so `doc(id).get()` is 1 read instead
of N. `deviceId` is unique per device, so `.limit(1)` is 1 read instead of the
result size (small today, but it is inside a transaction that retries on
contention).

**Fix**
- Ads: a direct `doc(id)` get on a canonical lower-case id (write a lower-case
  mirror document if legacy ids are mixed case).
- Spin/claim: add `.limit(1)`; `uniqueVehicleForDevice()` already rejects more
  than one flat, so the query never needs more.
- `readSpinStats`: query `where('societyId','==')` only. Move the whole-collection
  scan into the one-off backfill job (`/api/contest/spinstats/backfill`), run it
  once per society, and delete the scan.
- `latestWinnerFlat`: `.orderBy('createdAt','desc').limit(1)`.
- Retention: see §9.

**Impact: read −hundreds to thousands per day at current traffic; removes a
scaling cliff on `spinStats`.**

---

## 6. `GET /api/bookings` is public and explicitly uncacheable

`server/index.js:1178` sends `Cache-Control: public, no-store`, so neither the
browser nor any CDN may keep it, while each call runs 3 queries (§4). The
facility calendar is a page anyone can open and re-open.

**Fix:** `public, max-age=30, s-maxage=120, stale-while-revalidate=60`, plus the
§4 short-circuit. Bookings change on human timescales; a 30 s stale window is
harmless.

---

## 7. `app-version` polling is the largest per-user invocation source

`update-popup.js:11` defines a **60 s** interval, started at line 367, and each
tick GETs `/api/app-version` with `cache: 'no-store'` (lines 431-434), defeating the
route's own `max-age=60` (`server/index.js:680`). One app left open for a day =
**1,440 invocations**, each with a Firestore read (the db cache helps within an
instance, but instances are not guaranteed to stay warm).

**Fix**
- Cache the policy in `localStorage` for 6-24 h and check on cold start,
  `appStateChange`, and `visibilitychange` — not on a timer. Version policy
  changes are rare.
- If the timer is kept, stop it when hidden and after N hours, restart on focus.
- Give `/api/app-version` `public, max-age=600, s-maxage=3600` and let the
  client use the HTTP cache instead of `no-store`.

**Impact: the single biggest reduction for native users — up to ~99 % of these
invocations.**

---

## 8. Write amplification

- `POST /api/vehicles` writes `vehicleRegistrationLocks/{hash}` **on every
  registration** (`server/index.js:1477`) to serialise the count checks.
  That is one extra write per vehicle, forever. A `count()` aggregation inside
  the same transaction, or a sharded counter, removes the lock document.
- `POST /api/vehicles/import` opens **one transaction per 100 rows**
  (`vehicle-import.js:228`) and re-reads 3 society-wide queries inside each.
  A 2,000-row file = 20 transactions × 3 queries + 20 retry surfaces. Read once,
  then write in one or two batched commits.
- `POST /api/contest/winner` reads up to 4 attempt documents (`attemptDates()`,
  `server/index.js:1701-1706`) because it must support legacy UTC keys. After a
  rollout window, keep only today's IST key.
- `POST /api/contest/spinstats/backfill` rewrites documents with `societyId`;
  run it once per society and then drop the legacy scan path, or it will be run
  again and re-write the same documents.

**Impact: write −15-30 % on resident flows.**

---

## 9. Nothing in the database is ever deleted

There is no Firestore TTL policy and no `firestore.indexes.json` in the repo.
`bookings.expireAt` is written (`server/index.js:1980`) but **nothing reads it** —
`maintenance.cleanupOldBookings()` uses the `end` field and only runs when a
master admin presses a button (`server/lib/maintenance.js:34-42`). `contestAttempts`,
`spinStats`, `winners`, `bookings` and `giftCodes` grow without bound.

Storage is cheap (1 GiB free), but every one of these collections is scanned
somewhere (§5), so growth compounds read cost and slows queries.

**Fix (choose one)**
- Firestore **TTL policy** on `bookings.expireAt` and a new `expiresAt` on
  `contestAttempts` / `spinStats`. Note: **TTL deletes are billed** and are not
  in the free tier ($0.02/100k deletes — trivial here, but the guard will count
  them).
- Or let the MacBook's cron own cleanup (it already exists —
  `maintenance.schedule()`), which costs zero Firebase quota.
- Either way, add **daily aggregate documents** (`societyId + date -> spinCount`)
  so dashboards never scan history.

---

## 10. Use aggregation queries to count instead of reading

Firestore bills `count()` / `sum()` at **1 read per 1,000 index entries**
(minimum 1), so counting 400 documents costs 1 read instead of 400.

Places that read documents only to count or detect existence:
- per-flat vehicle counts in `GET /api/societies/:id/flats` (`server/index.js:1223-1232`);
- per-flat allowance counts in `POST /api/vehicles` (`server/index.js:1454-1457`
  counts by re-walking every row read for uniqueness);
- society-wide vehicle cap checks (`totalVehicleLimit`, `server/index.js:1405-1412`);
- `readSpinStats` totals and `documentsMatched` reporting.

**Fix:** `count()` on the composed query (`flatNumber` + `vehicleType`), or a
`flatCounts` map document maintained on write when you also need the number
without a round trip.

---

## 11. Move public read traffic off the Function

The public GETs (`/api/societies`, `/api/config`, `/api/ads/global`,
`/api/app-version`, `/api/facilities/:id`, `/api/notices/:id`) change rarely.

1. **Compress responses.** `compression` is not installed; every JSON body is
   sent uncompressed. A 100 KB vehicle list becomes ~10 KB. This is pure
   *egress* reduction and free to add (`app.use(compression())`, or let the
   Hosting CDN gzip/brotli).
2. **Cache at the CDN.** Firebase Hosting does *not* cache dynamic content by
   default, but it honours `s-maxage` on responses served through a rewrite.
   Adding `public, max-age=60, s-maxage=600, stale-while-revalidate=60` to those
   routes and a Hosting rewrite makes repeat hits free (no invocation, no read).
   Today Hosting is not deployed at all (`README.md`, §Maintenance), so this is
   also the one deployment that pays for itself.
3. **Or publish static JSON snapshots to GitHub Pages.** The site is already
   there; the MacBook or the admin portal can regenerate `society-index.json`,
   `config.json`, `ads-global.json`. Pages has no per-request billing and very
   tolerant caching. Cheapest option, at the cost of a small publish step.

---

## 12. Run the API somewhere other than Firebase for the free-est outcome

The repo already supports this (`DATA_BACKEND=local`, `AUTH_MODE=local`,
`server/lib/local-store.js`, `docs/macbook-testing.md`). If "lowest possible" is
the actual requirement:

- Keep Cloud Functions for **admin writes only**, and serve public reads from
  GitHub Pages JSON (§11) — that removes the majority of reads/invocations.
- Or move the same Express app to a long-running host. A ₹0 VPS / the MacBook
  is genuinely free; Cloud Run with `min-instances=0` is the same platform with
  the same billing, so it is not a saving by itself.
- `QUOTA_ACTION=off` is already the default when `DATA_BACKEND=local`.

**Important:** do not let two backends write the same data — gift codes would be
redeemable twice and reads would go stale (`docs/deployment.md:141`). Choose one
writer and make the other read-only/static.

---

## 13. Costs the quota guard never sees

These can bill you while all five tracked meters look healthy:

- **Artifact Registry / Container Registry** — every deploy stores an image;
  first 500 MB free, then $0.10/GB/month. Prune to the last 2-3 versions
  (`gcloud artifacts docker images list/delete`).
- **Cloud Build minutes** — each deploy builds; batch deploys.
- **Cloud Logging** — `server/index.js` logs per request (`CORS blocked` at `server/index.js:251`,
  `[auth]` warnings, `[quota]` lines, `console.error` in most handlers). Log
  ingestion is billed beyond the free allotment; drop or sample the per-request
  `console.log` in production.
- **Cloud Monitoring API** — the guard calls **5 time series every 60 s per
  instance** (`server/lib/gcp-monitoring.js:58-72`, `QUOTA_REFRESH_MS=60000`).
  Free today, but it is latency and a failure mode: stop mode *fails closed*
  when Monitoring is unreachable (`docs/deployment.md:103`). Raise
  `QUOTA_REFRESH_MS` to 5 min and/or persist the snapshot so instances share one
  poll.
- **Firestore index storage and egress** — every `societyName` / `society` field
  creates index entries. After §4 the legacy fields (and their indexes) can be
  dropped.
- **Firebase Hosting bandwidth** if you deploy it; keep it to the small JSON.

---

## 14. Configuration knobs to tighten today

| Knob | Current | Suggestion | Why |
| --- | --- | --- | --- |
| `timeoutSeconds` (`server/firebase.js:27`) | 60 | 20-30 | a stuck request should not run to 60 s of GB-seconds |
| `memory` | 256 MiB | keep | minimum practical with `firebase-admin` |
| `CONCURRENCY` | 20 | 20-40 | more concurrency = fewer instances for the same traffic |
| `MAX_INSTANCES` | 2 | keep | a spike cannot fan out into 50 instances |
| `QUOTA_THRESHOLD` | 0.8 | keep (0.75 for headroom) | earlier stop = less overage |
| `QUOTA_REFRESH_MS` | 60 s | 300 s | fewer Monitoring calls, fewer false drains |
| `READ_CACHE_TTL_MS` | 20 s | 60-120 s for public reads | writes already invalidate |
| CORS `maxAge` | not set (`server/index.js:257`) | `86400` | see §15 |

---

## 15. Correctness/behaviour issues that inflate cost

- **CORS preflight has no `maxAge`.** `Authorization` and `X-Firebase-AppCheck`
  are non-simple headers, so the browser sends an `OPTIONS` preflight before
  (repeated) API calls from `prsd503.github.io` to the Function host. `cors()`
  is mounted before the guard, so the preflight is cheap in-process — but it is
  still a **billed invocation** and the browser falls back to a short default
  cache. Set `maxAge: 86400`.
- **`verifyIdToken(token, true)`** (`server/index.js:292`) enables
  `checkRevoked`, which costs an extra Google Identity Toolkit lookup per
  authenticated request. It is not a Firestore read, but it is latency inside
  billed compute and a quota surface on the Auth API. Drop it unless immediate
  revocation is a requirement.
- **`/api/auth/forgot-password`** calls `credential.getAccessToken()` and
  identitytoolkit for *every* address, existing or not
  (`server/index.js:1281-1291`). Rate-limit by IP and skip the call for
  syntactically invalid addresses (it already 400s those) — and consider
  answering 202 without calling Google at all.
- **`/api/health` and `/api/quota`** are `no-store`; `/api/health` can be
  `max-age=60`. Both are exempt from the guard, so they are pure invocation cost
  when a monitor polls them.
- **`express-rate-limit` uses the in-process store.** With 2 instances the
  effective limit is 2× and resets on cold start. Not a billing bug, but the
  guard's anti-abuse value is lower than it reads.

---

## 16. Suggested order of work (all steps are now implemented — see §18)

| Step | Sections | Risk | Expected saving |
| --- | --- | --- | --- |
| 1 | §1 client dedupe, §2 drop `fresh`, §4 query short-circuit | low | inv −40-60 %, read −50 % |
| 2 | §5 ads/spin `.limit()` + `latestWinnerFlat` | low | read −hundreds/day |
| 3 | §7 update-popup polling | low | inv up to −1,400/day/native user |
| 4 | §11 compression + `s-maxage` (+ Hosting CDN if acceptable) | low-medium | egress −80 %, inv −50 % |
| 5 | §3 `flatLower`, §10 `count()`, §9 retention | medium | read scales with flats, not societies |
| 6 | §13 image pruning, log level, Monitoring refresh | none | $ only |
| 7 | §12 static JSON / MacBook for public reads | medium | approaches zero |

---

## 17. How to verify each change

The repo already ships the instruments:

```bash
curl https://api.owlwatcher.tech/api/quota     # reads/writes/deletes/invocations now
npm run quota:status -- https://api.owlwatcher.tech/api
```

- Take `/api/quota` before and after each change; the `usage` block is the
  per-instance counter, `remoteUsage` the Monitoring figure.
- Load the home page once, then compare the delta — that is the number §1 and
  §2 are aimed at.
- `npm test && npm run check` — `tests/quota.test.js`,
  `tests/firebase-api-server.test.js` and `tests/local-server.test.js` cover the
  cache/invalidation and counter contract these changes rely on. `tests/
  firebase-api.test.js` shows the expected request shapes.
- A change is safe only if repeated reads still return the value a write just
  stored — that is the `db-layer` invalidation test.

---

## 18. Implementation status (what changed, and what it saves)

Every item above is implemented on the current branch, in the same Firebase
Cloud Function deployment (no architecture change). Behaviour is unchanged:
`npm test` is 383 tests: 381 pass, 1 skipped, 1 fails only because
`firebase-functions` is not installed in this checkout
(`tests/dependency-smoke.test.js`, an environment check, not a product test).
`npm run check` is clean. `tests/cost-reduction.test.js`
pins the read/write budget of these changes so a future edit cannot quietly
reintroduce the scans.

### Measured result

Two identical workloads against the real API with a 40-vehicle society
(`READ_CACHE_TTL_MS=60000`, five resident page loads + three admin dashboard
loads). Reads come from the API's own Firestore counter:

| Workload | Before | After | |
| --- | --- | --- | --- |
| 5 resident page loads | 144 | **9** | −94 % |
| 3 admin dashboard loads | 354 | **60** | −83 % |
| Total | 498 | **69** | −86 % |

Before a society has been migrated (§ below) the same run is **134** reads
(29 resident + 105 admin) — still −73 %. A resident flat lookup costs 23 reads
there versus 11 once migrated: the case-variant query answers it, and the
society-wide scan is reached only when no casing of the typed flat matches at
all. Of what remains after migration, the largest line is the admin vehicle
register itself (40 documents), which is the data the page displays.

### What each section became

| § | Change | Where |
| --- | --- | --- |
| 1 | Empty-body `/auth/token` calls are skipped when there is no Firebase session (`index.html`, `facility.html`, `notice.html`); `/config` is read once per load; the ads and active-guard "other casing" retries are gone; a facility load reuses one header build; the admin save asks for the flat instead of the whole society; `entry.html` no longer needs a society read per keystroke. | client pages |
| 2 | The per-collection read cache is the default for ordinary reads; `{fresh:true}` now survives only on writes-of-read-data paths (delete/replace guards, the migration scan). Membership reads use a 5 s TTL instead of bypassing the cache. | `lib/db-layer.js`, `lib/authorization.js` |
| 3 | `POST /api/vehicles` no longer reads the whole society inside the transaction: the flat's own documents answer uniqueness/allowance, and the society-wide cap is an aggregate `count()` once the society is migrated. The dispatch registration lock is written only when a vehicle is created. | `server/index.js` |
| 4 | `readSocietyScoped()` runs the canonical `societyId` query, then the legacy name queries **only until the society is migrated**; `societyFlags/{societyId}` records that, set by the one-off migration. `getSocietyDocument()` reads the society-keyed document first and stops. | `server/index.js` |
| 5 | Ads read `ads/{society}` directly (scan only as a fallback, cached 60 s); the spin/claim device lookup is `.limit(2)`; `readSpinStats` reads the society's documents and only scans when none exist; `latestWinnerFlat` sorts at most the society's winners. | `server/index.js` |
| 6 | `GET /api/bookings` → `public, max-age=30, s-maxage=120, stale-while-revalidate=60`. | `server/index.js` |
| 7 | The update popup no longer polls every 60 s: the policy is kept in `localStorage` for 12 h, re-checked on start/focus/online, and `/api/app-version` is sent with `max-age=600, s-maxage=3600`. | `update-popup.js`, `server/index.js` |
| 8 | CORS preflight cached 24 h (`maxAge: 86400`) — this was one wasted invocation per JSON/Auth request; function timeout 60 → 30 s; `QUOTA_REFRESH_MS` 60 → 300 s; `READ_CACHE_TTL_MS` 20 → 60 s; imports read the registry once for the whole file instead of once per 100 rows. | `server/index.js`, `server/firebase.js`, `.env` examples |
| 9 | The maintenance job gains `pruneSpinHistory()` (attempts older than 7 days, day buckets older than 5 years), exposed as `POST /api/maintenance/prune-spin-history` and in the master portal. | `lib/maintenance.js`, `admin-logic.js` |
| 10 | Per-flat counts in `GET /api/societies/:id/flats` and the society vehicle cap use aggregate `count()` (billed per 1,000 documents). | `server/index.js`, `lib/local-store.js` |

### The one-off migration (do this once per society)

The three-query fan-out cannot be removed safely until every legacy record
carries its `societyId` (a record with only a name field would otherwise
disappear from the admin and resident views). So it stays, unchanged, until a
society is explicitly migrated:

1. Sign in to the master portal, type the society name in
   **Society spin counts → Society name**, then press
   **Speed up reads (tag legacy records once)**.
   (or `POST /api/maintenance/migrate-society {"societyName":"Aangan"}`).
2. The job stamps `societyId` on every legacy vehicle/booking/guard/admin record
   that names the society, adds `flatLower` to its vehicles, and records the fact
   in `societyFlags/{societyId}`. It is idempotent and touches no record that
   already belongs to another society.
3. From then on that society's scoped reads are one query, the resident flat
   lookup is two, and the registration cap is a count — the numbers in the table
   above. Un-migrated societies keep working exactly as before, only at the old
   read cost.

The `societyFlags` document is fetched once per instance-minute and is invisible
to the public `GET /api/societies` (it is a separate collection).

### Knobs now used

| Knob | New default | Note |
| --- | --- | --- |
| `READ_CACHE_TTL_MS` | `60000` | Writes invalidate the collection, so this is a cache of unchanged data. `0` disables it (tests use that). |
| `LEGACY_QUERY_CACHE_MS` (constant) | `300000` | The name-field fallback queries of an un-migrated society are pure fallbacks, so they are cached for five minutes; running the migration makes them unnecessary entirely. |
| `QUOTA_REFRESH_MS` | `300000` | Monitoring series per instance: 5 calls / 5 min instead of / 1 min. |
| Function `timeoutSeconds` | `30` | Was 60. |
| CORS `maxAge` | `86400` | Browsers cache the preflight for a day. |

### Verifying after deploy

```bash
curl https://api.owlwatcher.tech/api/quota    # usage before
# open the site / admin portal a few times
curl https://api.owlwatcher.tech/api/quota    # usage after: compare reads
```

Expect roughly what the table shows for the same workload, and remember the
free band is 50,000 reads / 20,000 writes / 20,000 deletes per Pacific day.
