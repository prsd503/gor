# Firestore Rules review and staged replacement

## Scope and status

This is a source-level review of the Rules text supplied by the project owner on
2026-11-22. The review did not independently fetch the deployed Ruleset. The
current Firebase API pilot remains read-only, and **no production Rules, IAM,
Firestore records, frontend, or deployment were changed by this document**.

The supplied Rules are not suitable for a public production app:

- `/vehicles` permits unauthenticated reads, creates, and updates.
- `/notices` permits unauthenticated reads, creates, and updates.
- `/admins`, `/guards`, `/societies`, `/ads`, `/facilities`, `/bookings`, and
  `/configs` permit public reads, which can expose membership, contact, vehicle,
  resident, and society details.
- Any authenticated account satisfying the email/UID existence check gets the
  broad `isAdmin`/`isGuard` access; those checks are not society-scoped and do
  not require `email_verified` or a stable UID binding.
- The `ads` create/update conditions are not a trustworthy approval workflow:
  ordinary signed-in users can create qualifying records and can modify
  approval-related fields.
- The client-side device-to-flat checks can be bypassed by direct Firestore
  writes. App Check and CORS do not replace authorization.

Consequently the read-only Cloud Function gate and its quota guard do not stop
clients that call Firestore directly. The Admin SDK used by the API also bypasses
Firestore Rules, so every server handler needs its own authorization and input
validation.

## Candidate client Rules

`firestore.rules` is a deliberately restrictive candidate. It allows only the
three exact, read-only document gets found in the current web source:

- `app_config/appVersion` (update-popup fallback)
- `ads/Aangan` (greeting-page compatibility fallback)
- `settings/contact` (studio contact fallback)

All other direct client reads and writes are denied. The project uses API routes
for the rest of the data access. The visual frontends can remain intact while
their data calls are served by the API, but the Rules candidate must be tested
against a representative Android and GitHub Pages build before production use.

`firebase.rules.json` intentionally contains only the Firestore Rules config, so
any later Rules release can be targeted independently. It is not a deployment
command. **Do not deploy this candidate yet.** The full API authorization work,
Firestore Emulator Rules tests, and end-to-end compatibility checks are still
required first. A Rules change can break any untracked client or direct Firestore
flow, and publication is a separate production action.

## Accepted resident/device behavior and limits

The product requirement is to retain the existing device-ID-only resident
linkage. The current UI obtains a Capacitor identifier on native builds and a
browser `localStorage` value on web, then checks the device/flat link in the
browser. That identifier is client-supplied and can be spoofed or reset; it is a
pseudonymous anti-abuse key, **not strong proof of residency**.

The full API should preserve the visible enrollment/contest workflow while
moving the current checks to the server:

- Resolve every society to the canonical `/societies/{societyId}` document.
- Enforce the one-device-per-flat and one-flat-per-device constraints in a
  server transaction, plus vehicle limits and duplicate plate checks.
- Keep contest attempts and wins server-side and bind them to the registered
  device, society, flat, and contest; `localStorage` is only a UI hint.
- Never trust a submitted flat, society, answer, or win as authoritative.
- Keep the existing gift-code contract: validation is non-consuming; Share
  redeems transactionally. Gift codes remain bearer credentials.

These controls prevent ordinary client-side bypasses and race conditions, but
they cannot turn a spoofable device ID into identity proof. The system must not
claim that it verifies a human resident or property ownership.

## Remaining release blockers

1. Bind admin/guard membership to verified Firebase identities and enforce
   canonical society scope on every API route. Treat `admins.isMaster` as
   privileged data; client Rules must not allow ordinary clients to modify it.
2. Protect sensitive API projections; remove full collection reads and GET side
   effects. Server mutations need their own validation and transaction logic.
3. Add and run Firebase Emulator Rules tests for anonymous, resident/guest,
   guard, society admin, master admin, and cross-society attempts. Static tests
   alone do not validate Rules semantics.
4. Review direct Firestore fallback paths and App Check behavior on supported
   frontends. Keep the existing public update-policy/greeting/contact reads
   narrow.
5. The deployed runtime identity is currently **Datastore Viewer**. Full API
   writes need separately reviewed least-privilege IAM; do not grant write roles
   or change the account until the server implementation is tested.
6. Prepare a dry-run mapping of legacy `society`/`societyName` values to
   canonical society document IDs. Do not mutate production data as part of the
   dry run.

The live pilot must remain read-only until these blockers pass review and the
owner separately authorizes each production Rules/IAM/API deployment.
