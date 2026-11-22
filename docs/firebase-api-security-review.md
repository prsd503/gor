# Firebase API preparation: authorization review

Repository review only, not a penetration test or an audit of live Firestore
rules, IAM, clients, credentials or deployed resources. No production records
were read or modified. Findings refer to routes in `server/index.js` at this
branch. The pilot gate mitigates exposure on **the Firebase entry point only**;
it does not repair the underlying handlers or change MacBook/VPS behavior.

## Release decision

**BLOCKED for a full public application rollout.** The initial Function admits
only reviewed public GET/HEAD paths plus health/quota diagnostics. It rejects
all private reads, authentication, gift-code operations and writes before any
handler/auth/Monitoring work. A dedicated Firestore Viewer runtime identity is
also required. Do not relax the gate, grant runtime writes, expose an unrestricted
MacBook tunnel, or move existing frontends to this pilot to make login work.

## Findings and required follow-up

| Route family | Observed behavior without the pilot gate | Required work before full release |
| --- | --- | --- |
| GET `/api/admins`, `/api/admins/:email`, `/api/admins/verify-society` | No route-level authentication; administrator records looked up or scanned from caller-supplied identifiers. | Authenticate intended roles; derive society scope server-side; return an explicit minimal response schema, not entire documents. |
| GET `/api/guards`, `/api/vehicles`, `/api/verify-device/:deviceId` | No route-level authentication; optional query filters and device IDs are not credentials; responses include document data. | Bind identity to society/device server-side; enforce scope even when filters are absent or forged; redact personal fields. |
| GET `/api/notices/:societyIdentifier` | No route-level authentication; also calls `maintenance.checkAndShiftNotices()`, which can write across notice documents. | Remove GET side effects; scope access; review notice rotation as a separate scheduled operation. |
| GET `/api/facilities/:societyIdentifier`, `/api/bookings`, `/api/societies` and subroutes | No route-level authentication; caller chooses society; full documents or contact details can be returned. | Define which fields are truly public; authenticate private reads; enforce membership/resource ownership, including active-guard contact access. |
| POST `/api/vehicles` | New resident records can be created without sign-in; edits require admin, but fields/device/society originate in the request. | Decide a legitimate registration credential/flow; rate/abuse controls; prevent cross-society data submission, duplicate spam and unauthorized edits. |
| POST `/api/contest/spin`, `/api/contest/winner`; GET contest results/stats | Public mutations accept society/flat values; transaction protects increment races, not eligibility or genuine winner claims. | Server-verified eligibility/winner proof and abuse/idempotency controls; decide privacy of results. |
| POST `/api/auth/forgot-password` | Public account lookup reveals role membership and triggers reset email workflow. | Review enumeration, generic responses, rate limits, and supported provider flow; test against abuse without sending real emails. |
| POST `/api/auth/token` | Verified Firebase identity plus trusted custom claims/ADMIN_UIDS; ordinary sign-in no longer automatically grants global admin. | Preserve the fixed global-admin policy; define society admin/guard membership and revocation; do not trust client role fields. |
| POST/PATCH/DELETE admin routes (config, notices, guards, vehicles, facilities, bookings, society limits/flats, ads) | Generally require verified **global** admin, not society ownership. | Decide whether global authority is intended; introduce scoped authorization where necessary; verify target document society from storage before mutation. |
| PATCH `/api/societies/:societyId/active-guard` | Requires sign-in, but not admin/guard membership or target-society authority. | Bind active-guard change to authorized identities/assignments in the requested society; deny cross-tenant targets. |
| POST `/api/gift-codes/validate`, `/api/gift-codes/redeem` | Code is a bearer credential, no account; validation read-only, consumption transactional. | Retain this contract, add focused brute-force/abuse controls and observability; verify write-scoped runtime permissions before a separately reviewed release. Do not copy codes into an independent fallback database. |
| POST `/api/gift-codes` | Requires global admin to mint codes. | Audit staff authority and issuance limits, keep creation private; do not release minting merely to test redemption. |
| GET `/api/config` | Returns complete config document without auth. | Explicit public projection or protected endpoint; audit fields before exposing. |
| Public ads and app version | Already allowed in the restricted MacBook pilot. | Confirm owners intend returned ad fields to be public; keep exact safe identifiers and fail-closed quota behavior. Do not generalize to arbitrary GET routes. |

App Check monitor mode is not authentication; CORS is a browser-origin policy,
not a credential. Non-browser requests can omit/spoof Origin. The initial gate
still applies to them. Admin SDK access bypasses client Firestore rules, so rules
alone do not repair these handlers. Conversely, this API gate cannot secure
clients that talk to Firestore directly: review deployed rules separately.

## Required acceptance tests for any future full release

- Anonymous/ordinary/guard/society-admin/global-admin roles; revoked membership.
- Identity A cannot query, enumerate, update or delete society B's resources,
  with or without forged query/body/path society identifiers or document IDs.
- Missing filters do not broaden access; response fields exclude private data.
- GET/HEAD do not write; no background job mutates data without explicit approval.
- Refresh can revalidate an unused bouquet code; simultaneous consumes have one
  winner; disabling after validation blocks transfer; no offline bypass.
- Malformed/expired/wrong-project tokens and old unversioned admin JWTs fail.
- CORS + native origins + App Check on actual Android build and GitHub Pages.
- Monitoring failure/80% drain cannot be bypassed using fallback/direct Firestore.
- No source/credentials/local data in deployed static files or function bundle.

The new automated pilot tests verify that the gate rejects legacy routes before
accessing Firebase/auth/Monitoring, not that these underlying findings are fixed.
