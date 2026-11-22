# Firebase API and Firestore Rules security review

## Scope and deployment state

This is a source-level review of the Rules text supplied in chat and the current
branch. The deployed Ruleset and production Firestore records were **not** fetched.
This is not a penetration test or a live Firebase audit. No production data, IAM,
Rules, frontend hosting configuration, or deployments were changed. The live
Firebase Function remains the previously deployed read-only pilot: private routes
and writes are blocked there.

At the user's request, this branch now stages a full-feature HTTP API profile
that removes the global read-only gate while preserving route-level identity,
membership, society-scope, validation and quota checks. This code has not been
deployed; the full API release is not ready until the IAM, runtime config, and
other blockers below are addressed. The separate candidate at `firestore.rules`
remains un-deployed (`firebase.rules.json` is a Firestore-only config).

## Supplied Rules findings

The supplied Rules text is not safe for production direct client access:

- `/vehicles` and `/notices` allow public reads and client creates/updates.
- `/admins`, `/guards`, `/societies`, `/ads`, `/facilities`, `/bookings`, and
  `/configs` allow public reads, exposing membership and resident/contact data.
- Email/UID record-existence helpers are not a server-side membership check and
  do not enforce society scope; the Rules expose the membership collections used
  by those helpers.
- `ads` create/update rules can be satisfied by ordinary signed-in clients and
  permit approval-related fields to be changed.
- Client-side device/flat checks can be bypassed by direct writes. App Check and
  CORS are not authorization.

The Admin SDK used by the API bypasses Firestore Rules. Rules cannot fix an API
handler that fails to authenticate/authorize its caller.

## Staged Rules candidate

`firestore.rules` denies all client access except exact document `get`s for the
current app-version fallback (`app_config/appVersion`), greeting compatibility
fallback (`ads/Aangan`), and studio contact fallback (`settings/contact`). It
allows no client writes or collection listing. These are document-level grants;
Firestore Rules cannot redact fields from a document read, so an owner must
confirm those three documents contain only public data or remove the exception
and serve a safe API projection instead.

`firebase.rules.json` isolates Rules configuration from the deployed API/Hosting
configuration. It is not a deployment command. Static source tests pass, but no
Firestore Emulator Rules test was run: Java is not installed in this workspace.
The candidate needs emulator tests and representative Android/GitHub Pages checks
before any independently approved Rules deployment. No live Ruleset comparison
has been completed.

## Staged server authorization and behavior

- Authentication verifies Firebase ID tokens (including revocation) or a signed
  backend identity token. Role claims, old role-bearing JWTs, and `ADMIN_UIDS`
  do not authorize application access.
- Staff membership comes from `admins`/`guards`, matched to a verified email; if
  the record carries a UID, that UID must match. An `isMaster` record grants
  global scope only while it is not disabled and not inactive. Regular
  admins/guards are scoped to one canonical `/societies/{id}` document. Society
  `name`, `legacyNames`, and `aliases` are the only accepted human/legacy
  references; ambiguous/unmapped values fail closed.
- Staff reads and mutations are scoped by the resolved membership, not by a
  caller-controlled path/query/body. Global settings, ad approval, and gift-code
  issuance require master membership. Public API reads return explicit
  projections; vehicle/contest resident lookups query by plate, flat, or device
  rather than loading every society vehicle. GET notices no longer mutate data,
  and gift-code behavior remains public and transactional: validation does not
  consume; redemption rechecks and consumes once.
- Resident vehicle creation checks canonical society, flat membership, device ↔
  flat locks, duplicate plates, vehicle types/mobile format, and per-flat limits
  in a Firestore transaction. Contest attempts/winner claims are also recorded
  and checked transactionally against the registered device/flat. A device ID
  observed on multiple flats fails closed in lookup, contest eligibility, and
  winner claims. Existing visible flows remain guest-facing; only request
  metadata needed by the server was added to the contest call. GitHub
  Pages/Android were not switched to a new backend.

These automated checks use an isolated local Firestore-compatible store, not a
production Firestore emulator. The user-selected device-ID-only residency flow
is preserved, but device IDs are client-controlled, spoofable/resettable
identifiers, **not proof of human residency or ownership**. A public flat lookup
returns full resident/vehicle fields only when that exact ID is already linked
to the flat; another device receives a lock marker, and unbound legacy records
return slot counts without plates or contact details. A person who can spoof or
obtain the registered ID can still impersonate that device and read its fields.
This residual risk must be explicitly reviewed before a public full-API release,
not represented as high-assurance privacy or identity proof.

## Release blockers / follow-up

1. Compare the candidate with the actual deployed Ruleset; run Emulator Rules
   tests for anonymous, ordinary user, resident/guest, guard, society admin,
   master, and cross-society attempts. Confirm no untracked client depends on
   direct Firestore access.
2. Review/approve account-to-membership binding, verified-email state, master
   record protection, canonical society IDs, and legacy aliases. No production
   mapping or membership records were changed.
3. The deployed API runtime remains **Datastore Viewer**. The full-profile code
   on this branch can reach mutation handlers, but those writes will fail on the
   current identity. Do not grant write IAM or deploy the full profile until the
   server implementation, transaction behavior, IAM scope, and operational
   budget are separately reviewed. The 80% guard is not a hard billing cap.
4. The current vehicle registration and contest APIs use device IDs for
   compatibility. They improve race/bypass resistance but cannot authenticate a
   resident. Higher-assurance protection requires a separate identity proof that
   the owner has not selected for this scope.
5. Confirm all public ad and greeting fields are intentionally public. Public
   ad content currently includes the client-rendered contest configuration; a
   correct answer delivered to a browser cannot be kept secret from that browser.
6. Run Android/Web App Check and GitHub Pages end-to-end tests after emulator
   Rules testing. The pilot, branch tests, and successful prior curl checks do
   not verify these full flows.

Production remains on the prior read-only pilot. No Rules deployment, IAM/data
change, frontend cutover, or full-profile API release has occurred. See
`docs/firebase-api-full-release.md` for the staged profile and remaining gates.
