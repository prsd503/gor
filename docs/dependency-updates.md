# Dependency refresh before the initial Firebase deployment

## What changed

The root lockfile was older than `server/package-lock.json`. Its npm audit
reported 18 affected packages (including high/critical transitive findings),
while the separately locked Firebase backend reported two moderate findings
through `node-cron -> uuid`. Root audit results are not the backend audit.

- Refreshed root dependencies within their existing declared version ranges.
  This resolves the patched Express/proxy/body-parser and Firebase/Google SDK
  dependency trees without a forced major upgrade of those direct dependencies.
- Explicitly upgraded **node-cron from 3.0.3 to 4.6.0** in both manifests and
  lockfiles, removing its old uuid dependency. No uuid override was used.
- Updated the maintenance adapter for v4: schedule starts automatically, the
  removed `scheduled` option is no longer passed, and the callback returns its
  promise with `noOverlap: true`. Overlap prevention is per process, not a
  distributed lock. Midnight Asia/Kolkata and caller-selected cron/timezone
  behavior are preserved. MacBook startup still has its existing separate
  startup-maintenance behavior; this change does not newly enable jobs there.
- The root and backend locks now both resolve Firebase Admin **14.5.1**, Express
  **5.3.0**, and node-cron **4.6.0**. Only the cron manifest range required a major
  version change. Keep and install from the reviewed lockfiles.

The initial Firebase entry still exports only the read-only HTTP API. No
Scheduler export, process cron, write permissions, frontend URL change, cloud
deployment, DNS/IAM change or production-data mutation was introduced.

## Repeatable local checks (Node 22)

After the change is reviewed/merged, update the Mac folder without overwriting
`.env.macbook` or credentials. From the updated project root:

```sh
node --version
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm audit
npm --prefix server audit --omit=dev
npm test
npm run check
```

Validation at this change: **0 reported vulnerabilities** in the root audit and
backend production audit; **222 tests passed**. npm audit is a point-in-time
advisory check, not a security guarantee or proof the full API can be released.
New advisories may change the result even with unchanged lockfiles.

Do not run `npm audit fix --force`, delete the lockfiles to silence a report, or
approve every dependency install script. Production dependencies in both trees
were freshly installed here with `--ignore-scripts`, with actual SDK-import and
scheduler tests in addition to mocked cloud integration tests. No live Firebase
request was used as a dependency smoke test.

The previously flagged `@firebase/util` postinstall writes Firebase defaults to
its own distribution files and, when `FIREBASE_WEBAPP_CONFIG` is set, can read a
config file or fetch web configuration. The `protobufjs` postinstall checks and
warns about dependency version-scheme declarations. Those scripts were inspected,
not blanket-approved or manually executed in this work. The published packages
already include the code needed by our tested imports. If a future dependency
requires a build script, review it and retest rather than disabling protections
globally. Cloud build/deployment install behavior is separate and remains to be
verified in the supervised deployment; the existing deployment hooks were not
changed by this dependency fix.

## Next deployment prerequisites

Follow [the API-only setup guide](firebase-api-setup.md): create the dedicated
`owl-api-readonly` runtime account with **Cloud Datastore Viewer** and
**Monitoring Viewer**, enable Monitoring, prepare the private `server/.env`, and
run the local deployment preflight. Do not create a JSON service-account key.
No deploy until those checks pass and deployment is explicitly approved.

The [authorization review](firebase-api-security-review.md) remains a blocker
for full login, private-data access, gift-code operations and writes. Passing
tests and audit does not remove that restriction.
